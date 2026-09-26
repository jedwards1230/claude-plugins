#!/usr/bin/env bash
# Encode rendered frames plus the offline mix into the delivery MP4s with ffmpeg: two-pass
# loudnorm (I=-14.5 LUFS, TP=-1.2 dBTP, LRA=11 unless told otherwise), H.264 high profile yuv420p,
# AAC, +faststart, title/comment metadata, a soft mov_text subtitle track from the SRT, and up to
# three variants: master (1080-line, CRF 20), share (same size, CRF 27) and phone (720-line, a
# bitrate cap sized so the file stays under the limit, re-encoded lower until it does).
# tools/export.mjs --mode ffmpeg calls this; it also runs on its own (see --help).
set -euo pipefail

usage() {
  tee <<'EOF'
Usage: tools/mux.sh --frames <dir> --audio <mix.wav> --out <dir> --slug <name> [options]

  --frames <dir>        JPEG frames f00000.jpg, f00001.jpg, ... (tools/render.mjs video)
  --fps <n>             frame rate (default 30)
  --audio <wav>         the offline mix (tools/render.mjs audio)
  --norm <wav>          where to write the loudness-normalized mix (default <audio>_norm.wav)
  --srt <file>          captions to embed as a soft subtitle track (optional)
  --out <dir>           output directory (created if missing)
  --slug <name>         file names <slug>.mp4, <slug>-share.mp4, <slug>-phone.mp4
  --variants <list>     comma list from master,share,phone (default: all three)
  --duration <s>        film length in seconds (default: frame count / fps)
  --title <text>        metadata title
  --comment <text>      metadata comment (for example the AI-made note)
  --description <text> metadata description
  --lufs <x>            integrated loudness target (default -14.5, or env LUFS)
  --tp <x>              true-peak ceiling in dBTP (default -1.2, or env TP)
  --lra <x>             loudness range target (default 11, or env LRA)
  --phone-mib <x>       phone file size limit in MiB (default 30)
  --normalize-only      write the normalized mix (--norm) and stop
  --no-loudnorm         --audio is already normalized: encode it as is
  -h, --help            this help
EOF
}

die() { echo "mux.sh: $*" >&2; exit 2; }

FRAMES='' FPS=30 AUDIO='' NORM='' SRT='' OUT='' SLUG='' VARIANTS='master,share,phone' DUR=''
TITLE='' COMMENT='' DESC='' PHONE_MIB=30 ONLY_NORM=0 LOUDNORM=1
LUFS=${LUFS:--14.5} TP=${TP:--1.2} LRA=${LRA:-11}
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --normalize-only) ONLY_NORM=1; shift ;;
    --no-loudnorm) LOUDNORM=0; shift ;;
    --frames) FRAMES=${2:?}; shift 2 ;;
    --fps) FPS=${2:?}; shift 2 ;;
    --audio) AUDIO=${2:?}; shift 2 ;;
    --norm) NORM=${2:?}; shift 2 ;;
    --srt) SRT=${2:-}; shift 2 ;;
    --out) OUT=${2:?}; shift 2 ;;
    --slug) SLUG=${2:?}; shift 2 ;;
    --variants) VARIANTS=${2:?}; shift 2 ;;
    --duration) DUR=${2:?}; shift 2 ;;
    --title) TITLE=${2:-}; shift 2 ;;
    --comment) COMMENT=${2:-}; shift 2 ;;
    --description) DESC=${2:-}; shift 2 ;;
    --lufs) LUFS=${2:?}; shift 2 ;;
    --tp) TP=${2:?}; shift 2 ;;
    --lra) LRA=${2:?}; shift 2 ;;
    --phone-mib) PHONE_MIB=${2:?}; shift 2 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg not found on PATH (use tools/export.mjs --mode webcodecs instead)"
command -v ffprobe >/dev/null 2>&1 || die "ffprobe not found on PATH"
[[ -n "$AUDIO" && -f "$AUDIO" ]] || die "--audio: no such file '${AUDIO}'"
NORM=${NORM:-${AUDIO%.wav}_norm.wav}

# ---- loudness: measure, then normalize with the measured values (linear when the peaks allow)
if (( LOUDNORM )); then
  M=$(ffmpeg -hide_banner -nostats -i "$AUDIO" -af "loudnorm=I=${LUFS}:TP=${TP}:LRA=${LRA}:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
  val() { printf '%s\n' "$M" | sed -n "s/.*\"$1\" : \"\([^\"]*\)\".*/\1/p"; }
  IN_I=$(val input_i)
  [[ -n "$IN_I" ]] || die "loudnorm could not measure ${AUDIO}"
  echo "mux: loudnorm measured I=${IN_I} LUFS, TP=$(val input_tp) dBTP, LRA=$(val input_lra) LU; target I=${LUFS} TP=${TP} LRA=${LRA}" >&2
  if [[ "$IN_I" == "-inf" ]]; then
    echo "mux: the mix is silent; encoding it as is" >&2
    ffmpeg -y -hide_banner -v error -i "$AUDIO" -ar 48000 "$NORM"
  else
    ffmpeg -y -hide_banner -v error -i "$AUDIO" -af "loudnorm=I=${LUFS}:TP=${TP}:LRA=${LRA}:measured_I=${IN_I}:measured_TP=$(val input_tp):measured_LRA=$(val input_lra):measured_thresh=$(val input_thresh):offset=$(val target_offset):linear=true" -ar 48000 "$NORM"
  fi
else
  NORM=$AUDIO
fi
(( ONLY_NORM )) && exit 0

[[ -n "$FRAMES" && -f "$FRAMES/f00000.jpg" ]] || die "--frames: no f00000.jpg in '${FRAMES}'"
[[ -n "$OUT" && -n "$SLUG" ]] || die "--out and --slug are required"
[[ -z "$SRT" || -f "$SRT" ]] || die "--srt: no such file '${SRT}'"
mkdir -p "$OUT"
if [[ -z "$DUR" ]]; then
  n=$(find "$FRAMES" -maxdepth 1 -name 'f*.jpg' | wc -l)
  DUR=$(awk -v n="$n" -v f="$FPS" 'BEGIN { printf "%.3f", n / f }')
fi
WH=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$FRAMES/f00000.jpg")
W=${WH%%x*} H=${WH##*x}
[[ "$W" =~ ^[0-9]+$ && "$H" =~ ^[0-9]+$ ]] || die "could not read the frame size of $FRAMES/f00000.jpg"
SHORT=$(( W < H ? W : H ))

# scale filter that brings the short side down to $1 (never up)
scale_to() {
  if (( SHORT <= $1 )); then echo null
  elif (( W >= H )); then echo "scale=-2:$1:flags=lanczos"
  else echo "scale=$1:-2:flags=lanczos"; fi
}

# encode <file> <video filter> <audio bitrate> <x264 args...>
encode() {
  local out=$1 vf=$2 ab=$3
  shift 3
  local sub_in=() sub_map=()
  if [[ -n "$SRT" ]]; then
    sub_in=(-i "$SRT")
    sub_map=(-map 2:s -c:s mov_text -metadata:s:s:0 language=eng)
  fi
  ffmpeg -y -hide_banner -v error -framerate "$FPS" -i "$FRAMES/f%05d.jpg" -i "$NORM" ${sub_in[@]+"${sub_in[@]}"} \
    -map 0:v -map 1:a ${sub_map[@]+"${sub_map[@]}"} -vf "${vf},format=yuv420p" \
    -c:v libx264 -profile:v high -pix_fmt yuv420p -preset slow -tune film "$@" \
    -c:a aac -b:a "$ab" -ar 48000 -t "$DUR" -movflags +faststart \
    -metadata title="$TITLE" -metadata comment="$COMMENT" -metadata description="$DESC" "$out"
  echo "mux: wrote ${out} ($(wc -c < "$out" | tr -d ' ') bytes)" >&2
}

IFS=',' read -r -a WANT <<< "$VARIANTS"
for v in "${WANT[@]}"; do
  case "$v" in
    master) encode "$OUT/$SLUG.mp4" "$(scale_to 1080)" 192k -crf 20 ;;
    share) encode "$OUT/$SLUG-share.mp4" "$(scale_to 1080)" 160k -crf 27 ;;
    phone)
      limit=$(awk -v m="$PHONE_MIB" 'BEGIN { printf "%d", m * 1048576 }')
      # video kbit/s that fills 95% of the limit after 128k audio, capped at 4000 for 720p
      kbps=$(awk -v l="$limit" -v d="$DUR" 'BEGIN { k = int((l * 0.95 * 8 / d - 128000) / 1000); if (k > 4000) k = 4000; if (k < 150) k = 150; print k }')
      f="$OUT/$SLUG-phone.mp4"
      for _ in 1 2 3 4; do
        encode "$f" "$(scale_to 720)" 128k -crf 23 -maxrate "${kbps}k" -bufsize "$(( kbps * 2 ))k"
        size=$(wc -c < "$f" | tr -d ' ')
        (( size < limit )) && break
        echo "mux: phone copy is ${size} bytes, over the ${PHONE_MIB} MiB limit; re-encoding lower" >&2
        kbps=$(( kbps * 4 / 5 ))
      done
      (( $(wc -c < "$f" | tr -d ' ') < limit )) || die "phone copy is still over ${PHONE_MIB} MiB"
      ;;
    '') ;;
    *) die "unknown variant '${v}' (use master, share, phone)" ;;
  esac
done
