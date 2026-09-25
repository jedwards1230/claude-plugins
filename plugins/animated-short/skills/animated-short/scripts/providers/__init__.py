"""Provider registry, per-film context and the fallback walker.

    ctx = Context(film_dir, film)                       # film = film.json with defaults applied
    res = run_role(ctx, "tts", {"text": ..., "voice": ..., "out_dir": ..., "stem": ...},
                   stage="voice", sticky=True)

run_role walks the role's candidates in registry order after the license filter (commercial_safe),
opt-in, retirement and block-list filters; a film.json providers.roles override or --model goes
first. For each candidate: cache lookup ($0, recorded as basis "cache"), ledger reservation
(estimate x 1.2, refused over budget), the call, the recorded cost. Only AvailabilityError moves
to the next candidate. A sticky role (tts voice, image model) that already has a choice in
work/state.json uses exactly that choice; if it fails, run_role stops (StickyFailure).
"""

import datetime
import json
import os
import re
from pathlib import Path

from .base import AvailabilityError, ProviderUnavailable, Result, StickyFailure, UsageError
from .cache import Cache, make_key
from .ledger import Ledger, file_lock
from .local import LOCAL_CLASSES
from .openrouter import ROLE_CLASSES, OpenRouter, load_key

HERE = Path(__file__).resolve().parent


class Registry:
    def __init__(self, data):
        self.data = data
        self.roles = data["roles"]
        for role, cands in self.roles.items():
            for c in cands:
                c.setdefault("role", role)

    @classmethod
    def load(cls, path=None):
        path = path or os.environ.get("ANIMATED_SHORT_REGISTRY") or HERE / "registry.json"
        with open(path, encoding="utf-8") as f:
            return cls(json.load(f))

    def candidates(self, role):
        if role not in self.roles:
            raise UsageError(f"unknown role {role!r} (roles: {', '.join(self.roles)})")
        return self.roles[role]

    def find(self, role, ref):
        """Candidate by id or model id within a role."""
        return next((c for c in self.candidates(role) if ref in (c["id"], c.get("model"))), None)

    def by_id(self, cid):
        return next((c for cands in self.roles.values() for c in cands if c["id"] == cid), None)

    def blocked(self, model):
        for b in self.data.get("blocked", []):
            if re.search(b["pattern"], model or ""):
                return b["reason"]
        return None

    def sticky_fields(self, role):
        return self.data.get("sticky", {}).get(role)

    def chain(self, role, tier="final", commercial_safe=True, override=None, today=None):
        """-> (ordered candidates, [{"id", "why"}] skipped)."""
        today = today or datetime.date.today().isoformat()
        out, skipped = [], []
        first = None
        if override:
            reason = self.blocked(override)
            if reason:
                raise UsageError(f"{override} is blocked: {reason}")
            first = self.find(role, override)
            if first is None:
                raise UsageError(
                    f"{override} is not a {role} candidate in the registry (scripts/providers/registry.json)"
                )
            if commercial_safe and first.get("terms", {}).get("commercial") is not True:
                raise UsageError(
                    f"{override} is not cleared for commercial use; set providers.commercial_safe to false "
                    "in film.json to use it anyway"
                )
            if first.get("retires") and first["retires"] < today:
                raise UsageError(f"{override} retired on {first['retires']}")
            out.append(first)
        for c in self.candidates(role):
            if c is first or tier not in c.get("tiers", ["final"]):
                continue
            why = None
            if c.get("opt_in"):
                why = "opt-in (name it in providers.roles or --model)"
            elif commercial_safe and c.get("terms", {}).get("commercial") is not True:
                why = "not cleared for commercial use (commercial_safe is on)"
            elif c.get("retires") and c["retires"] < today:
                why = f"retired {c['retires']}"
            elif self.blocked(c.get("model")):
                why = self.blocked(c.get("model"))
            if why:
                skipped.append({"id": c["id"], "why": why})
            else:
                out.append(c)
        return out, skipped


class Context:
    """Everything a tool needs for provider calls on one film. The key is loaded lazily, so free
    and local work never needs it."""

    def __init__(
        self, film_dir, film, registry=None, key_file=None, base_url=None, account_ceiling=None, use_cache=True
    ):
        self.dir = Path(film_dir)
        self.film = film
        self.registry = registry or Registry.load()
        self.key_file, self.base_url, self.use_cache = key_file, base_url, use_cache
        self._key, self._key_loaded, self._client, self._catalog = None, False, None, None
        if account_ceiling is None:
            account_ceiling = os.environ.get("ANIMATED_SHORT_ACCOUNT_CEILING") or None
        self.ledger = Ledger(
            self.dir / "ledger.jsonl",
            film.get("budget_usd", 10),
            account_ceiling,
            usage_fn=lambda: self.client().usage(),
        )
        self.cache = Cache(self.dir / "cache")

    # ---- credentials and catalog
    def key(self):
        if not self._key_loaded:
            self._key, self._key_loaded = load_key(self.key_file), True
        return self._key

    def client(self):
        if self._client is None:
            self._client = OpenRouter(self.key(), self.base_url)
        return self._client

    def catalog(self):
        if self._catalog is None:
            self._catalog = {m["id"]: m for m in self.client().models()}
        return self._catalog

    def live_pricing(self):
        p = self.dir / "work" / "preflight.json"
        if p.exists():
            try:
                return json.loads(p.read_text()).get("pricing", {})
            except (json.JSONDecodeError, OSError):
                return {}
        return {}

    # ---- sticky choices (work/state.json)
    def _state_path(self):
        return self.dir / "work" / "state.json"

    def state(self):
        p = self._state_path()
        return json.loads(p.read_text()) if p.exists() else {}

    def get_sticky(self, key):
        return self.state().get("sticky", {}).get(key)

    def set_sticky(self, key, value):
        p = self._state_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with file_lock(str(p)):
            st = json.loads(p.read_text()) if p.exists() else {}
            st.setdefault("sticky", {})
            if key not in st["sticky"]:
                st["sticky"][key] = value
                tmp = p.with_suffix(".tmp")
                tmp.write_text(json.dumps(st, indent=1, sort_keys=True) + "\n")
                os.replace(tmp, p)

    # ---- providers
    def commercial_safe(self):
        return self.film.get("providers", {}).get("commercial_safe", True)

    def override(self, role):
        return (self.film.get("providers", {}).get("roles") or {}).get(role)

    def chain(self, role, tier="final", model=None):
        return self.registry.chain(role, tier, self.commercial_safe(), model or self.override(role))

    def provider(self, cand):
        if cand["provider"] == "local":
            return LOCAL_CLASSES[cand["model"]](cand, self)
        if cand["provider"] == "openrouter":
            return ROLE_CLASSES[cand["role"]](cand, self)
        raise UsageError(f"unknown provider {cand['provider']!r} for {cand['id']}")


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _pin(ctx, skey, cand, job, fields):
    """Record the first successful sticky choice (model plus the sticky job fields, e.g. voice)."""
    ctx.set_sticky(
        skey,
        dict({"candidate": cand["id"], "model": cand["model"], "since": _now()}, **{f: job.get(f) for f in fields}),
    )


def _suffixes(files, stem):
    out = {}
    for f in files:
        name = Path(f).name
        out[name[len(stem) :] if name.startswith(stem) else "_" + name] = f
    return out


def run_role(ctx, role, job, *, stage, tier="final", model=None, sticky=False, use_cache=True):
    """Run one job for a role through the fallback chain. -> Result (with .candidate, .fallbacks)."""
    fields = ctx.registry.sticky_fields(role) if sticky else None
    skey = f"{role}/{tier}" if fields is not None else None
    pinned = ctx.get_sticky(skey) if skey else None
    if pinned:
        cand = ctx.registry.by_id(pinned["candidate"])
        if cand is None:
            raise UsageError(f"work/state.json pins {role} to {pinned['candidate']}, which is not in the registry")
        want = model or ctx.override(role)
        if want and want not in (cand["id"], cand.get("model")):
            raise UsageError(
                f"{role} is pinned to {cand['model']} for this film (work/state.json sticky.{skey}); "
                f"it cannot switch to {want} mid-film"
            )
        for f in fields:
            if pinned.get(f) is not None and job.get(f) not in (None, pinned[f]):
                raise UsageError(
                    f"{role} {f} is pinned to {pinned[f]!r} for this film (work/state.json sticky.{skey}); "
                    f"this call asks for {job[f]!r}. Remove the entry only if every earlier asset is redone."
                )
            if job.get(f) is None and pinned.get(f) is not None:
                job[f] = pinned[f]
        chain = [cand]
    else:
        chain, _skipped = ctx.chain(role, tier, model)
    attempts = []
    out_dir, stem = job.get("out_dir"), job.get("stem", "out")
    for cand in chain:
        prov = ctx.provider(cand)
        ok, why = prov.available()
        if not ok:
            if pinned:
                raise StickyFailure(f"the pinned {role} choice {cand['id']} is unavailable ({why}); stop and report")
            attempts.append((cand["id"], why))
            continue
        key = None
        if use_cache and ctx.use_cache and prov.cacheable:
            key = make_key(
                cand["provider"],
                cand["model"],
                {
                    "params": cand.get("params", {}),
                    "job": {k: v for k, v in job.items() if k not in ("out_dir", "stem")},
                },
            )
            hit = ctx.cache.get(key)
            if hit:
                files = ctx.cache.restore(hit, out_dir or ctx.dir / "work", stem) if hit["files"] else []
                if not prov.local:
                    ctx.ledger.cache_hit(role, stage, cand["provider"], cand["model"], key)
                if skey and not pinned:
                    _pin(ctx, skey, cand, job, fields)
                return Result(files=files, usd=0.0, basis="cache", data=hit["data"], candidate=cand, fallbacks=attempts)
        try:
            if prov.local:
                res = prov.run(**job)
            else:
                est = prov.estimate(**job)
                ctx.ledger.ensure_anchor()
                with ctx.ledger.reserve(role, stage, est, cand["provider"], cand["model"]) as rsv:
                    try:
                        res = prov.run(**job)
                    except AvailabilityError as e:
                        if e.maybe_charged:
                            rsv.record(est, basis="estimate", note=f"outcome unknown: {str(e)[:120]}")
                        else:
                            rsv.release(str(e))
                        raise
                    if res.usd is not None:
                        rsv.record(res.usd, res.basis)
                    else:
                        rsv.record(None)
        except AvailabilityError as e:
            if pinned:
                raise StickyFailure(
                    f"the pinned {role} choice {cand['id']} failed ({e}); stop and report: "
                    "switching mid-film is not allowed"
                ) from None
            attempts.append((cand["id"], str(e)))
            continue
        if key:
            ctx.cache.put(
                key,
                _suffixes(res.files, stem),
                data=res.data,
                provider=cand["provider"],
                model=cand["model"],
                usd=res.usd,
                basis=res.basis,
            )
        if skey and not pinned:
            _pin(ctx, skey, cand, job, fields)
        res.candidate, res.fallbacks = cand, attempts
        return res
    raise ProviderUnavailable(role, attempts)
