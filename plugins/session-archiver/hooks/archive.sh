#!/usr/bin/env bash
# Stage 1 — runs inside Claude Code on SessionEnd / Stop / StopFailure / PreCompact.
#
# Cheap, local-only, never blocks session exit:
#   read transcript_path -> mirror the session locally -> (optionally) hand the
#   network upload to Stage 2 (spool) or a detached background process (inline).
#
# Always exits 0 and prints nothing on stdout (silent hook). All four events may
# fire for one session; a per-session lock + mtime-skip collapse that to <=1
# real archive per change.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../scripts/lib.sh
. "$PLUGIN_ROOT/scripts/lib.sh"

# Read the hook payload from stdin.
PAYLOAD="$(cat 2>/dev/null || true)"
exit_clean() { exit 0; }   # hooks must never fail the session

command -v jq >/dev/null 2>&1 || exit_clean

TRANSCRIPT="$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // empty' 2>/dev/null)"
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit_clean

sa_init
[ "$SA_ENABLED" = "true" ] || exit_clean

# Derive the session unit from the authoritative transcript_path.
BASE="$(dirname "$TRANSCRIPT")"          # ~/.claude/projects/<slug>
UUID="$(basename "$TRANSCRIPT" .jsonl)"  # <session-uuid>
PROJECT="$(basename "$BASE")"            # <slug> (already filesystem-safe)
SUBDIR="$BASE/$UUID"                     # holds tool-results/ and subagents/

# Per-project opt-out (substring/glob match against the slug or its real cwd).
CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)"
while IFS= read -r g; do
  [ -n "$g" ] || continue
  case "$PROJECT" in $g) sa_log "skip $UUID: project '$PROJECT' matches exclude '$g'"; exit_clean ;; esac
  case "$CWD"     in $g) sa_log "skip $UUID: cwd '$CWD' matches exclude '$g'"; exit_clean ;; esac
done <<EOF
$(jq -r '.exclude_project_globs[]? // empty' "$SA_CONFIG" 2>/dev/null)
EOF

# Serialize concurrent fires for the same session.
sa_acquire_lock "archive-$UUID" || exit_clean
trap 'sa_release_lock "archive-$UUID"' EXIT

# Skip if the transcript hasn't changed since we last archived it.
STATE_FILE="$SA_STATE/$UUID"
SIG="$(sa_mtime "$TRANSCRIPT"):$(sa_size "$TRANSCRIPT")"
if [ -f "$STATE_FILE" ] && [ "$(cat "$STATE_FILE" 2>/dev/null)" = "$SIG" ]; then
  exit_clean
fi

# ── Local mirror (always) ─────────────────────────────────────────────────────
# umask 077 so every dir/file we create below (incl. intermediate host/project
# dirs) is private — transcripts contain whatever tools read.
umask 077
DEST="$SA_MIRROR/$SA_HOST/$PROJECT/$UUID"
mkdir -p "$DEST" 2>/dev/null || { sa_log "cannot create mirror $DEST"; exit_clean; }
# Tighten perms on every level — umask only governs dirs we create fresh, so an
# intermediate dir that pre-existed with a looser mode would still leak the list
# of archived session IDs to other local users.
chmod 700 "$SA_MIRROR" "$SA_MIRROR/$SA_HOST" "$SA_MIRROR/$SA_HOST/$PROJECT" "$DEST" 2>/dev/null || true

# Mirror the transcript itself (the load-bearing file) and gate everything on it.
# The sidecars are secondary, but a failure on either means "not fully archived"
# so we must NOT record the state signature — otherwise a failed copy (disk full,
# permissions, transient I/O) would permanently skip future retries.
mirror_ok=1
if command -v rsync >/dev/null 2>&1; then
  rsync -a "$TRANSCRIPT" "$DEST/" 2>>"$SA_LOG" || mirror_ok=0
  if [ -d "$SUBDIR" ]; then
    EXC=()
    [ "$SA_INCLUDE_SUBAGENTS" = "true" ]    || EXC+=(--exclude 'subagents' --exclude 'subagents/')
    [ "$SA_INCLUDE_TOOL_RESULTS" = "true" ] || EXC+=(--exclude 'tool-results' --exclude 'tool-results/')
    # ${EXC[@]+...} keeps an empty array safe under `set -u` on bash 3.2.
    rsync -a ${EXC[@]+"${EXC[@]}"} "$SUBDIR/" "$DEST/" 2>>"$SA_LOG" || mirror_ok=0
  fi
else
  cp -p "$TRANSCRIPT" "$DEST/" 2>>"$SA_LOG" || mirror_ok=0
  if [ -d "$SUBDIR" ]; then cp -pR "$SUBDIR/." "$DEST/" 2>>"$SA_LOG" || mirror_ok=0; fi
fi

if [ "$mirror_ok" != "1" ]; then
  sa_log "mirror FAILED for $UUID — leaving state unrecorded so the next event retries"
  exit_clean
fi
sa_log "mirrored $UUID ($PROJECT) -> $DEST"

# Record the new signature only now that the local copy is known-good.
printf '%s' "$SIG" > "$STATE_FILE" 2>/dev/null || true

# ── Remote handoff ────────────────────────────────────────────────────────────
case "$SA_MODE" in
  local-only)
    : # local mirror only; nothing remote
    ;;
  inline)
    # Detached, never blocks exit. Best-effort; the local mirror is the safety net.
    nohup bash "$PLUGIN_ROOT/scripts/sync-session.sh" "$DEST" "$PROJECT" "$UUID" \
      >/dev/null 2>&1 < /dev/null &
    ;;
  spool)
    if jq -nc --arg m "$DEST" --arg p "$PROJECT" --arg s "$UUID" --arg h "$SA_HOST" \
         '{mirror:$m, project:$p, session:$s, host:$h}' > "$SA_SPOOL/$UUID" 2>/dev/null; then
      sa_log "spooled $UUID"
    else
      sa_log "warning: failed to write spool marker for $UUID — remote upload skipped (local mirror is intact)"
    fi
    ;;
  blocking)
    # Synchronous push — for ephemeral environments (CI runners) where a
    # detached or spooled upload would be killed at job teardown. Blocks the
    # hook until the upload finishes; idempotent delta sync keeps the per-event
    # cost low, and pushing on every event means we never depend on SessionEnd
    # actually firing in headless mode.
    bash "$PLUGIN_ROOT/scripts/sync-session.sh" "$DEST" "$PROJECT" "$UUID" >>"$SA_LOG" 2>&1 \
      || sa_log "blocking sync had failures for $UUID"
    ;;
  *)
    sa_log "unknown sync_mode '$SA_MODE' — treated as local-only"
    ;;
esac

# Opportunistic local-mirror retention (opt-in; internally rate-limited).
sa_prune_mirror

exit_clean
