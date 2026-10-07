"""Provider interface, error classes and availability-error classification.

A provider fills one role (tts, align, music, image, critic, video) for one registry candidate:
    probe(tier) -> {ok, reason, usd}      tier 0 = free checks, tier 1 = a sub-cent real call
    estimate(**job) -> usd                conservative cost of one run
    run(**job) -> Result(files, usd, basis, data)
Only availability errors (AvailabilityError) let the fallback walker move to the next candidate;
anything else is a real failure (ProviderError) and goes back to the caller or the review loop.
"""

import re
from dataclasses import dataclass, field

# exit codes shared by every tool
EXIT_OK, EXIT_GATE, EXIT_USAGE, EXIT_BUDGET, EXIT_UNAVAILABLE = 0, 1, 2, 3, 4


class ToolError(Exception):
    """Base for errors a tool reports as one line and an exit code."""

    exit_code = EXIT_GATE


class UsageError(ToolError):
    """Bad arguments, missing files or a missing environment piece."""

    exit_code = EXIT_USAGE


class BudgetRefused(ToolError):
    """The ledger refused a paid call (film budget or account ceiling)."""

    exit_code = EXIT_BUDGET


class ProviderUnavailable(ToolError):
    """Every candidate for a role failed with an availability error."""

    exit_code = EXIT_UNAVAILABLE

    def __init__(self, role, attempts):
        self.role, self.attempts = role, attempts
        detail = "; ".join(f"{cid}: {why}" for cid, why in attempts) or "no candidate passed the filters"
        super().__init__(f"no working provider for {role} ({detail})")


class StickyFailure(ToolError):
    """A sticky choice (voice, image model) failed; switching mid-film is not allowed."""

    exit_code = EXIT_UNAVAILABLE


class ProviderError(ToolError):
    """A provider call failed for a reason other than availability (bad input, bad output)."""

    exit_code = EXIT_GATE


class AvailabilityError(Exception):
    """The candidate cannot serve this call right now: the walker may try the next one.
    maybe_charged is True when the request may have reached the model (timeout mid-response)."""

    def __init__(self, message, status=None, maybe_charged=False):
        super().__init__(message)
        self.status, self.maybe_charged = status, maybe_charged


AVAILABILITY_STATUS = {401, 402, 403, 404, 408, 429}
UNSUPPORTED = re.compile(
    r"not supported|unsupported|does not support|no endpoints? found|not available|"
    r"invalid model|not a valid model|model not found|no allowed providers",
    re.I,
)


def is_availability(status, body=""):
    """HTTP status (+ body text) -> True when it is an availability error (fallback allowed)."""
    if status in AVAILABILITY_STATUS or (status is not None and status >= 500):
        return True
    if status in (400, 422) and UNSUPPORTED.search(body or ""):
        return True
    return False


@dataclass
class Result:
    files: list = field(default_factory=list)  # output paths
    usd: float = None  # actual cost when the provider reported it
    basis: str = "estimate"  # usage.cost | estimate | cache | local
    data: dict = field(default_factory=dict)  # role-specific output (words, text, ...)
    candidate: dict = None  # registry entry that served the call
    fallbacks: list = field(default_factory=list)  # [(candidate id, why)] tried before it


class Provider:
    """Base class. Subclasses implement run(); estimate() and probe() have sane defaults."""

    cacheable = True
    local = False

    def __init__(self, cand, ctx):
        self.cand, self.ctx = cand, ctx
        self.id, self.role, self.model = cand["id"], cand["role"], cand.get("model")
        self.terms = cand.get("terms", {})

    def available(self):
        """Can this candidate run at all on this machine (installed, configured)?"""
        return True, ""

    def estimate(self, **job):
        return float(self.cand.get("cost", {}).get("usd") or 0.0)

    def probe(self, tier=0):
        ok, why = self.available()
        return {"ok": ok, "reason": why or "available", "usd": 0.0}

    def run(self, **job):
        raise NotImplementedError


def sniff_audio(data):
    """Container of an audio byte string -> file extension."""
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return "mp3"
    if data[:4] == b"OggS":
        return "ogg"
    if data[:4] == b"fLaC":
        return "flac"
    if data[4:8] == b"ftyp":
        return "m4a"
    return "bin"


def sniff_image(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return "bin"
