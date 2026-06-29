#!/usr/bin/env bash
# Backfill existing sessions into the local mirror.
#
# The hooks only capture sessions that end/compact AFTER the plugin is enabled,
# so any session that already existed at install time is never archived — and is
# lost when Claude Code's cleanupPeriodDays (default 30) deletes it. Run this
# once after enabling the plugin to mirror the pre-existing backlog.
#
# Safe to re-run: unchanged sessions are skipped via the same mtime:size state
# signature the hook uses. Local mirror only by default; pass --remote to also
# push to enabled targets (when sync_mode is not local-only).
#
# Usage:
#   bash backfill.sh [--dry-run] [--project SUBSTR] [--projects-dir DIR] [--remote]
#
#   --dry-run         list what would be mirrored; copy nothing
#   --project SUBSTR  only sessions whose project slug contains SUBSTR
#   --projects-dir D  scan D instead of ~/.claude/projects
#   --remote          also push each mirrored session to enabled remote targets
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./lib.sh
. "$PLUGIN_ROOT/scripts/lib.sh"

DRY=0; PROJECT_FILTER=""; PROJECTS_DIR=""; DO_REMOTE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)        DRY=1 ;;
    --remote)         DO_REMOTE=1 ;;
    --project)        [ $# -ge 2 ] && [ -n "$2" ] || { echo "backfill: --project needs a value" >&2; exit 2; }; PROJECT_FILTER="$2"; shift ;;
    --project=*)      PROJECT_FILTER="${1#*=}"; [ -n "$PROJECT_FILTER" ] || { echo "backfill: --project needs a value" >&2; exit 2; } ;;
    --projects-dir)   [ $# -ge 2 ] && [ -n "$2" ] || { echo "backfill: --projects-dir needs a value" >&2; exit 2; }; PROJECTS_DIR="$2"; shift ;;
    --projects-dir=*) PROJECTS_DIR="${1#*=}"; [ -n "$PROJECTS_DIR" ] || { echo "backfill: --projects-dir needs a value" >&2; exit 2; } ;;
    -h|--help)        sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

command -v jq >/dev/null 2>&1 || { echo "backfill: jq is required" >&2; exit 1; }

sa_init
if [ "$SA_ENABLED" != "true" ]; then
  echo "backfill: session-archiver is not enabled (config: ${SA_CONFIG:-none})." >&2
  echo "          enable it in your config first, then re-run." >&2
  exit 1
fi

# Serialize overlapping runs. A periodic backfill timer (the recommended
# periodic-sync mode) can fire while a slow previous run is still copying; a
# second concurrent run detects the lock and exits cleanly (0), leaving the
# in-flight run to finish — rather than racing it on the same state files.
# Uses the same mkdir-based lock as the hook/drainer (no flock dependency).
if ! sa_acquire_lock "backfill"; then
  echo "backfill: another backfill run is in progress — exiting." >&2
  sa_log "backfill: another run holds the lock — exiting"
  exit 0
fi
trap 'sa_release_lock "backfill"' EXIT

PROJECTS_DIR="${PROJECTS_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects}"
[ -d "$PROJECTS_DIR" ] || { echo "backfill: no projects dir at $PROJECTS_DIR" >&2; exit 1; }

# Load per-project exclude globs once. Unlike the hook (which also matches the
# payload cwd), backfill can only match the project slug — historical sessions
# have no recorded cwd to check.
EXCLUDES=()
while IFS= read -r g; do [ -n "$g" ] && EXCLUDES+=("$g"); done <<EOF
$(jq -r '.exclude_project_globs[]? // empty' "$SA_CONFIG" 2>/dev/null)
EOF
is_excluded() {
  local project="$1" g
  for g in ${EXCLUDES[@]+"${EXCLUDES[@]}"}; do
    # shellcheck disable=SC2254
    case "$project" in $g) return 0 ;; esac
  done
  return 1
}

echo "backfill: $PROJECTS_DIR -> $SA_MIRROR/$SA_HOST  (mode=$SA_MODE, remote=$DO_REMOTE, dry-run=$DRY)"

total=0; mirrored=0; skipped=0; excluded=0; failed=0
for transcript in "$PROJECTS_DIR"/*/*.jsonl; do
  [ -f "$transcript" ] || continue          # no-match glob stays literal
  base="$(dirname "$transcript")"           # <projects>/<slug>
  uuid="$(basename "$transcript" .jsonl)"   # <session-uuid>
  project="$(basename "$base")"             # <slug>
  subdir="$base/$uuid"                       # holds subagents/ tool-results/

  if [ -n "$PROJECT_FILTER" ]; then
    case "$project" in *"$PROJECT_FILTER"*) : ;; *) continue ;; esac
  fi
  total=$((total + 1))

  if is_excluded "$project"; then
    excluded=$((excluded + 1)); continue
  fi

  # Skip if already mirrored and unchanged (same check the hook uses).
  state_file="$SA_STATE/$uuid"
  sig="$(sa_mtime "$transcript"):$(sa_size "$transcript")"
  if [ -f "$state_file" ] && [ "$(cat "$state_file" 2>/dev/null)" = "$sig" ]; then
    skipped=$((skipped + 1))
    # Already mirrored & unchanged — but still offer it to remotes when asked,
    # so --remote can push to a newly-enabled target or retry a past failure.
    if [ "$DRY" = 0 ] && [ "$DO_REMOTE" = 1 ] && [ "$SA_MODE" != "local-only" ]; then
      sa_sync_session "$(sa_dest_dir "$project" "$uuid")" "$project" "$uuid" \
        || sa_log "backfill: remote sync had failures for $uuid (unchanged)"
    fi
    continue
  fi

  if [ "$DRY" = 1 ]; then
    echo "  would mirror  $project/$uuid"
    mirrored=$((mirrored + 1)); continue
  fi

  if sa_mirror_session "$transcript" "$project" "$uuid" "$subdir"; then
    printf '%s' "$sig" > "$state_file" 2>/dev/null || true
    mirrored=$((mirrored + 1))
    sa_log "backfill: mirrored $uuid ($project)"
    echo "  mirrored      $project/$uuid"
    if [ "$DO_REMOTE" = 1 ] && [ "$SA_MODE" != "local-only" ]; then
      sa_sync_session "$(sa_dest_dir "$project" "$uuid")" "$project" "$uuid" \
        || sa_log "backfill: remote sync had failures for $uuid"
    fi
  else
    failed=$((failed + 1))
    echo "  FAILED        $project/$uuid" >&2
  fi
done

echo "backfill: done. scanned=$total mirrored=$mirrored skipped=$skipped excluded=$excluded failed=$failed"
[ "$failed" -eq 0 ]
