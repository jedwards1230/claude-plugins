#!/usr/bin/env bash
# Stage 2 — drain the spool to remote targets. Runs standalone (launchd /
# systemd timer / cron), OUTSIDE Claude Code, so it must not rely on
# CLAUDE_PLUGIN_ROOT or CLAUDE_PLUGIN_DATA being set.
#
# For each spooled session: re-sync its local mirror to all enabled targets;
# remove the spool marker only on full success. Anything left re-runs next tick.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

sa_init
if [ -z "$SA_CONFIG" ] || [ "$SA_ENABLED" != "true" ]; then exit 0; fi

# Single drainer at a time.
sa_acquire_lock "drain" || { sa_log "drain: another drain is running — skip"; exit 0; }
trap 'sa_release_lock "drain"' EXIT

[ -d "$SA_SPOOL" ] || exit 0
shopt -s nullglob 2>/dev/null || true

processed=0
for marker in "$SA_SPOOL"/*; do
  [ -f "$marker" ] || continue
  processed=$((processed + 1))
  mirror="$(jq -r '.mirror // empty'  "$marker" 2>/dev/null)"
  project="$(jq -r '.project // empty' "$marker" 2>/dev/null)"
  session="$(jq -r '.session // empty' "$marker" 2>/dev/null)"
  if [ -z "$mirror" ] || [ -z "$session" ]; then
    sa_log "drain: malformed marker $marker — removing"; rm -f "$marker" 2>/dev/null; continue
  fi
  if [ ! -d "$mirror" ]; then
    sa_log "drain: mirror gone for $session ($mirror) — removing marker"; rm -f "$marker" 2>/dev/null; continue
  fi
  if sa_sync_session "$mirror" "$project" "$session"; then
    rm -f "$marker" 2>/dev/null || true
    sa_log "drain: $session done, de-spooled"
  else
    sa_log "drain: $session has failing targets — keeping in spool for retry"
  fi
done

[ "$processed" -gt 0 ] && sa_log "drain: processed $processed marker(s)"
exit 0
