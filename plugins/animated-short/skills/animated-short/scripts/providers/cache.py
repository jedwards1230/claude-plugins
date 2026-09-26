"""Content-addressed provider cache under <film>/cache/<sha256>/.

The key is sha256 of the canonical JSON of (provider, model, params, input hashes): a retry or a
re-run with the same inputs is served from disk at $0 (the ledger records it with basis "cache").
Each entry holds the output files (named by their suffix after the job's stem) and meta.json.
"""

import datetime
import hashlib
import json
import os
import shutil
from pathlib import Path


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _canon(value):
    """Canonical form of a job value: files and bytes become content hashes."""
    if isinstance(value, Path):
        return {"file_sha256": file_sha256(value)}
    if isinstance(value, (bytes, bytearray)):
        return {"bytes_sha256": hashlib.sha256(value).hexdigest()}
    if isinstance(value, dict):
        return {str(k): _canon(v) for k, v in sorted(value.items())}
    if isinstance(value, (list, tuple)):
        return [_canon(v) for v in value]
    return value


def make_key(provider, model, params):
    blob = json.dumps(
        {"provider": provider, "model": model, "params": _canon(params)},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return hashlib.sha256(blob.encode()).hexdigest()


class Cache:
    def __init__(self, root):
        self.root = Path(root)

    def get(self, key):
        """-> {"files": {suffix: Path}, "data": dict, "meta": dict} or None."""
        d = self.root / key
        meta_f = d / "meta.json"
        if not meta_f.exists():
            return None
        meta = json.loads(meta_f.read_text())
        files = {suffix: d / name for suffix, name in meta.get("files", {}).items()}
        if not all(p.exists() for p in files.values()):
            return None
        return {"files": files, "data": meta.get("data", {}), "meta": meta}

    def put(self, key, files, data=None, **meta):
        """files: {suffix: Path of the produced file}. Copies them in; returns the entry dir."""
        d = self.root / key
        tmp = self.root / (key + ".tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        names = {}
        for i, (suffix, src) in enumerate(sorted(files.items())):
            name = f"f{i}{Path(str(src)).suffix}"
            shutil.copyfile(src, tmp / name)
            names[suffix] = name
        record = dict(
            meta,
            files=names,
            data=data or {},
            created=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        )
        (tmp / "meta.json").write_text(json.dumps(record, indent=1, sort_keys=True))
        shutil.rmtree(d, ignore_errors=True)
        os.replace(tmp, d)
        return d

    def restore(self, hit, out_dir, stem):
        """Copy a hit's files to out_dir/<stem><suffix>; -> list of paths."""
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        paths = []
        for suffix, src in sorted(hit["files"].items()):
            dst = out_dir / f"{stem}{suffix}"
            shutil.copyfile(src, dst)
            paths.append(dst)
        return paths
