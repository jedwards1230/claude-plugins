#!/usr/bin/env bash
# End-to-end conformance run of the golden example, at $0: copy the engine and examples/golden
# into a fresh film directory, npm install, then resolve, glyph test, purity, stills, text checks,
# frame QA images, the engine self-test (scripts/tests/engine_selftest.mjs: sticker placeholder and
# anchors, a font face that fails to load), the delivery probe, an export with --host artifact, the
# page self-test (scripts/tests/page_selftest.mjs: the film's title and description in the page's
# static tags, the artifact-ready page without a document wrapper or external URLs) and the
# technical check (which includes the audio null test). Prints a PASS/FAIL table and exits
# non-zero on any failure. No provider calls; the only network use is npm install.
# --no-ffmpeg runs everything with ffmpeg and ffprobe hidden from PATH (shadow directories that
# link every other program; nothing is deleted) and forces the in-browser WebCodecs export.
set -uo pipefail

usage() {
  tee <<'EOF'
Usage: scripts/test-golden.sh [--out <dir>] [--no-ffmpeg] [--aspect 16:9|9:16|1:1] [--end-card] [--force] [--scaffold-py]

  --out <dir>    where to build the test film (default: a new temporary directory)
  --no-ffmpeg    hide ffmpeg/ffprobe from PATH and export with --mode webcodecs
  --aspect <r>   16:9 (default, the shipped golden), 9:16 or 1:1 (size patched before resolve)
  --end-card     turn on config.disclosure.end_card
  --force        replace <dir> if it holds an earlier run of this script
  --scaffold-py  build the film with scripts/scaffold.py new --from-example golden instead of cp
  -h, --help     this help

Layout of <dir>: film/ (the film directory), logs/ (one log per step), nopath/ (--no-ffmpeg).
EOF
}
die() { echo "test-golden: $*" >&2; exit 2; }

SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT='' NOFF=0 ASPECT='16:9' ENDCARD=0 FORCE=0 SCAFFOLD_PY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --scaffold-py) SCAFFOLD_PY=1; shift ;;
    --out) OUT=${2:?--out needs a directory}; shift 2 ;;
    --no-ffmpeg) NOFF=1; shift ;;
    --aspect) ASPECT=${2:?--aspect needs a ratio}; shift 2 ;;
    --end-card) ENDCARD=1; shift ;;
    --force) FORCE=1; shift ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done
case "$ASPECT" in
  16:9) W=1920 H=1080 ;;
  9:16) W=1080 H=1920 ;;
  1:1) W=1080 H=1080 ;;
  *) die "--aspect must be 16:9, 9:16 or 1:1" ;;
esac
command -v node >/dev/null 2>&1 || die "node (18+) is required"
command -v npm >/dev/null 2>&1 || die "npm is required"

if [[ -z "$OUT" ]]; then OUT=$(mktemp -d "${TMPDIR:-/tmp}/animated-short-golden.XXXXXX"); fi
if [[ -d "$OUT" && -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
  if (( FORCE )) && [[ -f "$OUT/.golden-test" ]]; then rm -rf "$OUT"
  else die "$OUT is not empty (use --force to replace an earlier run of this script)"; fi
fi
mkdir -p "$OUT/logs" && OUT=$(cd "$OUT" && pwd) && touch "$OUT/.golden-test"
FILM="$OUT/film"

# ---- ffmpeg hidden from PATH: each PATH directory holding ffmpeg/ffprobe is replaced by a shadow
# directory that links everything else in it
if (( NOFF )); then
  newpath='' i=0
  IFS=':' read -r -a dirs <<< "$PATH"
  for dir in "${dirs[@]}"; do
    [[ -n "$dir" && -d "$dir" ]] || continue
    if [[ -e "$dir/ffmpeg" || -e "$dir/ffprobe" ]]; then
      i=$((i + 1)); shadow="$OUT/nopath/$i"; mkdir -p "$shadow"
      ln -s "$dir"/* "$shadow"/ 2>/dev/null
      rm -f "$shadow/ffmpeg" "$shadow/ffprobe" "$shadow/ffplay"
      dir=$shadow
    fi
    newpath=${newpath:+$newpath:}$dir
  done
  export PATH=$newpath
  hash -r
  echo "which ffmpeg: '$(command -v ffmpeg || true)'  which ffprobe: '$(command -v ffprobe || true)'"
fi

NAMES=() STATUS=() SECS=()
record() { NAMES+=("$1"); STATUS+=("$2"); SECS+=("$3"); printf '[%s] %-34s %4s s   %s\n' "$2" "$1" "$3" "$4"; }
# step <name> <command...>: run with output in logs/NN-name.log
step() {
  local name=$1 t0=$SECONDS log
  shift
  log="$OUT/logs/$(printf '%02d' "${#NAMES[@]}")-${name// /-}.log"
  LAST_LOG=$log
  if "$@" >"$log" 2>&1; then record "$name" PASS $((SECONDS - t0)) "$log"; return 0; fi
  record "$name" FAIL $((SECONDS - t0)) "$log"
  tail -n 5 "$log" | sed 's/^/        /'
  return 1
}
node_film() { node "$FILM/tools/$1" "${@:2}"; }

if (( NOFF )); then
  if [[ -z "$(command -v ffmpeg || true)$(command -v ffprobe || true)" ]]; then record 'ffmpeg hidden from PATH' PASS 0 "PATH has no ffmpeg or ffprobe"
  else record 'ffmpeg hidden from PATH' FAIL 0 "still found: $(command -v ffmpeg ffprobe | tr '\n' ' ')"; fi
fi

scaffold() {
  if (( SCAFFOLD_PY )); then
    python3 "$SKILL_DIR/scripts/scaffold.py" new "$FILM" --from-example golden || return 1
  else
    mkdir -p "$FILM" && cp -R "$SKILL_DIR/engine/." "$FILM/" && cp -R "$SKILL_DIR/examples/golden/." "$FILM/" && rm -rf "$FILM/node_modules" || return 1
  fi
  [[ "$ASPECT" == '16:9' && $ENDCARD -eq 0 ]] && return 0
  # patch the frame size in both the source storyboard and the config, and the end card switch
  node -e '
    const fs = require("fs"), [film, w, h, end] = process.argv.slice(1);
    const edit = (rel, fn) => { const p = film + "/" + rel, j = JSON.parse(fs.readFileSync(p, "utf8")); fn(j); fs.writeFileSync(p, JSON.stringify(j, null, 1) + "\n"); };
    edit("src/storyboard.json", (j) => { j.meta.size = [+w, +h]; });
    edit("web/film/config.json", (j) => { j.size = [+w, +h]; if (end === "1") j.disclosure = Object.assign({}, j.disclosure, { end_card: true }); });
    console.log("patched size " + w + "x" + h + (end === "1" ? " and the end card" : ""));
  ' "$FILM" "$W" "$H" "$ENDCARD"
}
step 'scaffold engine + golden' scaffold || { echo "test-golden: cannot continue"; exit 1; }
step 'npm install' npm install --prefix "$FILM" --no-audit --no-fund || { echo "test-golden: cannot continue"; exit 1; }

if [[ "$ASPECT" == '16:9' ]]; then
  # the shipped web/film/storyboard.json must be exactly what resolve produces
  reproduce() { node_film resolve.mjs --film "$FILM" --strict --out "$FILM/work/resolved.json" && cmp "$FILM/work/resolved.json" "$FILM/web/film/storyboard.json"; }
  step 'resolve reproduces shipped' reproduce
  step 'resolve --strict' node_film resolve.mjs --film "$FILM" --strict
else
  step 'resolve' node_film resolve.mjs --film "$FILM"
fi
step 'glyph test' node_film render.mjs glyph --film "$FILM"
step 'purity' node_film render.mjs purity --film "$FILM"
step 'stills' node_film render.mjs stills poster,0.5,2,5,8,9.5 --film "$FILM"
step 'text-check' node_film qa.mjs text-check --film "$FILM"
step 'qa contact sheet' node_film qa.mjs contact --film "$FILM"
step 'qa strip' node_film qa.mjs strip 4.3 --film "$FILM"
step 'qa crop' node_film qa.mjs crop 5.5 60,40,760,260 --film "$FILM"
step 'ascii' node_film qa.mjs ascii --film "$FILM"
step 'engine self-test' node "$SKILL_DIR/scripts/tests/engine_selftest.mjs" "$FILM"
step 'delivery probe' node_film export.mjs --probe --film "$FILM"
PROBE_LOG=$LAST_LOG
MODE=auto
(( NOFF )) && MODE=webcodecs
step "export --mode $MODE --host artifact" node_film export.mjs --film "$FILM" --mode "$MODE" --host artifact
step 'page self-test' node "$SKILL_DIR/scripts/tests/page_selftest.mjs" "$FILM"
checkjson() { mkdir -p "$FILM/work/qa" && node_film qa.mjs check --film "$FILM" --json > "$FILM/work/qa/check.json"; }
step 'technical check' checkjson

# ---- summary (JavaScript in single quotes on purpose: the shell passes values as arguments)
echo
# shellcheck disable=SC2016
node -e '
  const fs = require("fs"), film = process.argv[1];
  const read = (p) => { try { return JSON.parse(fs.readFileSync(film + "/" + p, "utf8")); } catch { return null; } };
  const probe = (() => { try { const s = fs.readFileSync(process.argv[2], "utf8"); return JSON.parse(s.slice(s.indexOf("{"))); } catch { return null; } })();
  if (probe && probe.auto) console.log(`auto mode here: ${probe.auto.mode} (${probe.auto.reason})`);
  const m = read("out/export.json");
  if (m) {
    console.log(`export: ${m.mode} (${m.reason}); loudness ${m.loudness.method}`);
    for (const f of m.files) console.log(`  ${f.path}  ${f.width}x${f.height}  ${f.duration} s  ${(f.bytes / 1048576).toFixed(2)} MiB  ${f.video}+${f.audio}${f.subtitles.length ? "+" + f.subtitles.join(",") : ""}  ${f.lufs} LUFS  TP ${f.true_peak} dBTP  (${f.loudness_by})`);
  }
  const c = read("work/qa/check.json");
  if (c) console.log(`technical check: ${c.verdict}, ${c.defects.length} defects` + (c.defects.length ? ": " + c.defects.map((d) => d.check + " " + d.issue).join("; ") : ""));
' "$FILM" "$PROBE_LOG"

fails=0
for s in "${STATUS[@]}"; do [[ "$s" == PASS ]] || fails=$((fails + 1)); done
echo
printf '%-36s %s\n' 'STEP' 'RESULT'
for k in "${!NAMES[@]}"; do printf '%-36s %s  (%s s)\n' "${NAMES[$k]}" "${STATUS[$k]}" "${SECS[$k]}"; done
echo "film: $FILM"
if (( fails )); then echo "test-golden: FAIL ($fails of ${#NAMES[@]} steps)"; exit 1; fi
echo "test-golden: PASS (${#NAMES[@]} steps)"
