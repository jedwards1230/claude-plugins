#!/usr/bin/env python3
"""Ask the critic model about a cut, a mix or stills: python3 critic.py ask --film <dir> --prompt-file P
[--video cut.mp4] [--audio a.wav ...] [--images a.jpg ...] [--tier draft|final|signoff] [--model M]
[--stage voice|animatic|assets|review]

The critic (a different model family from the builder) watches video with its audio track via a
video_url data URL, listens via input_audio and looks via image_url. A video larger than --max-mib
or taller than 720 lines is sent as a 720p H.264 proxy (ffmpeg) under the cap; the proxy used is
recorded. The reply goes to stdout and to work/critic/<time>-<name>.json (+ .md).
"""

import datetime
import json
import sys
from pathlib import Path

import audiolib
from common import add_film_arg, add_provider_args, context, load_film, parser, run_main, slug, usd, write_json
from providers import run_role
from providers.base import UsageError
from quote import STAGES

MIB = 1024 * 1024


def probe_media(path):
    """-> {duration, height, bytes} with ffprobe when present."""
    info = {"bytes": Path(path).stat().st_size, "duration": None, "height": None}
    if audiolib.which("ffprobe"):
        r = audiolib.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=height", "-of", "json", str(path)],
            check=False,
        )
        try:
            j = json.loads(r.stdout)
            info["duration"] = float(j.get("format", {}).get("duration") or 0) or None
            info["height"] = max([s.get("height") or 0 for s in j.get("streams", [])] or [0]) or None
        except (ValueError, TypeError):
            pass
    return info


def video_proxy(src, work, max_mib, max_height=720):
    """-> (path to send, proxy record or None)."""
    src = Path(src)
    info = probe_media(src)
    if info["bytes"] <= max_mib * MIB and (info["height"] or 0) <= max_height:
        return src, None
    if not audiolib.has_ffmpeg():
        raise UsageError(
            f"{src.name} is {info['bytes'] / MIB:.1f} MiB (cap {max_mib}) and ffmpeg is not available to make a "
            "720p proxy; export a smaller review cut (e.g. the -phone.mp4 variant)"
        )
    work.mkdir(parents=True, exist_ok=True)
    out = work / f"proxy-{src.stem}-720p.mp4"
    crf, bitrate = 28, None
    for _attempt in range(4):
        cmd = [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(src),
            "-vf",
            f"scale=-2:'min({max_height},ih)'",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
        ]
        cmd += (
            ["-b:v", f"{bitrate}k", "-maxrate", f"{bitrate}k", "-bufsize", f"{2 * bitrate}k"]
            if bitrate
            else ["-crf", str(crf)]
        )
        cmd += ["-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(out)]
        audiolib.run(cmd)
        size = out.stat().st_size
        if size <= max_mib * MIB:
            return out, {
                "source": str(src),
                "sent": str(out),
                "bytes": size,
                "height": max_height,
                "encoding": f"crf {crf}" if not bitrate else f"{bitrate} kbit/s",
            }
        dur = info["duration"] or 90
        bitrate = max(150, int((max_mib * MIB * 8 / dur) / 1000 * 0.85) - 96)
        crf += 4
    raise UsageError(f"could not fit {src.name} under {max_mib} MiB")


def audio_proxy(src, work, max_mib):
    src = Path(src)
    if src.stat().st_size <= max_mib * MIB:
        return src, None
    if not audiolib.has_ffmpeg():
        raise UsageError(f"{src.name} is over {max_mib} MiB and ffmpeg is not available to compress it")
    out = Path(work) / f"proxy-{src.stem}.mp3"
    out.parent.mkdir(parents=True, exist_ok=True)
    audiolib.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-c:a", "libmp3lame", "-b:a", "128k", str(out)])
    return out, {"source": str(src), "sent": str(out), "bytes": out.stat().st_size, "encoding": "mp3 128k"}


def ask(
    ctx,
    prompt,
    video=None,
    audio=(),
    images=(),
    tier="final",
    model=None,
    name="ask",
    max_mib=20.0,
    stage="review",
    use_cache=True,
):
    """Run one critic call; -> (reply text, record dict). The record is also saved under work/critic/."""
    work = ctx.dir / "work" / "critic"
    media, proxies, secs = [], [], None
    send_video = None
    if video:
        send_video, prox = video_proxy(video, work, max_mib)
        info = probe_media(send_video)
        secs = info["duration"]
        media.append({"kind": "video", "path": str(video), "sent": str(send_video), "bytes": info["bytes"]})
        if prox:
            proxies.append(prox)
    send_audio = []
    for f in audio or ():
        s, prox = audio_proxy(f, work, max_mib)
        send_audio.append(s)
        media.append({"kind": "audio", "path": str(f), "sent": str(s), "bytes": Path(s).stat().st_size})
        if prox:
            proxies.append(prox)
        if secs is None and Path(s).suffix.lower() == ".wav":
            secs = audiolib.wav_duration(s)
    for f in images or ():
        if not Path(f).exists():
            raise UsageError(f"{f}: no such file")
        media.append({"kind": "image", "path": str(f), "sent": str(f), "bytes": Path(f).stat().st_size})
    total = sum(m["bytes"] for m in media)
    if total > max_mib * MIB * 1.5:
        raise UsageError(f"media total {total / MIB:.1f} MiB is over the cap; send fewer or smaller files")
    res = run_role(
        ctx,
        "critic",
        {
            "prompt": prompt,
            "video": Path(send_video) if send_video else None,
            "audio": [Path(p) for p in send_audio],
            "images": [Path(p) for p in images or ()],
            "media_seconds": secs,
        },
        stage=stage,
        tier=tier,
        model=model,
        use_cache=use_cache,
    )
    text = res.data.get("text", "")
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    record = {
        "name": name,
        "model": res.candidate["model"],
        "tier": tier,
        "usd": res.usd,
        "basis": res.basis,
        "fallbacks": res.fallbacks,
        "media": media,
        "proxies": proxies,
        "prompt": prompt,
        "text": text,
    }
    base = work / f"{stamp}-{slug(name)}"
    write_json(base.with_suffix(".json"), record)
    base.with_suffix(".md").write_text(text + "\n", encoding="utf-8")
    record["saved"] = str(base.with_suffix(".json"))
    return text, record


def cmd_ask(a):
    film = load_film(a.film)
    ctx = context(a, film)
    prompt = Path(a.prompt_file).read_text(encoding="utf-8")
    text, rec = ask(
        ctx,
        prompt,
        a.video,
        a.audio or [],
        a.images or [],
        a.tier,
        a.model,
        a.name or Path(a.prompt_file).stem,
        a.max_mib,
        stage=a.stage,
        use_cache=not a.no_cache,
    )
    print(text)
    cost = "cached" if rec["basis"] == "cache" else (usd(rec["usd"]) if rec["usd"] is not None else "estimated")
    proxy = f"; sent a proxy: {rec['proxies'][0]['sent']}" if rec["proxies"] else ""
    print(f"\n[critic: {rec['model']}, {cost}{proxy}; saved {rec['saved']}]", file=sys.stderr)
    return 0


def main(argv=None):
    ap = parser("critic.py", __doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("ask", help="send a prompt plus media to the critic model")
    add_film_arg(p)
    add_provider_args(p)
    p.add_argument("--prompt-file", required=True)
    p.add_argument("--video", help="review cut (MP4); a 720p proxy is sent when it is too big")
    p.add_argument("--audio", nargs="*", help="audio files (wav, mp3)")
    p.add_argument("--images", nargs="*", help="stills or contact sheets (png, jpg, webp)")
    p.add_argument(
        "--tier", default="final", choices=("final", "draft", "signoff"), help="signoff = the stronger model"
    )
    p.add_argument("--model", help="critic model to try first (default: the registry order for the tier)")
    p.add_argument("--max-mib", type=float, default=20.0, help="size cap per media file before base64 (default 20)")
    p.add_argument("--name", help="label for the saved reply (default: the prompt file name)")
    p.add_argument(
        "--stage",
        default="review",
        choices=STAGES,
        help="the quote.py stage this call's spend belongs to in the ledger (default review): voice for audition "
        "and take picks, animatic, assets for the music pick",
    )
    a = ap.parse_args(argv)
    return cmd_ask(a)


if __name__ == "__main__":
    run_main(main)
