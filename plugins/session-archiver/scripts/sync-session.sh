#!/usr/bin/env bash
# Push one already-mirrored session to every enabled remote target.
#
# Usage: sync-session.sh <mirror-dir> <project> <session>
# Used by:
#   - hooks/archive.sh (inline mode, detached)
#   - scripts/drain.sh (spool mode)
# Exit 0 only if all enabled targets succeeded.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

[ "$#" -ge 3 ] || { echo "usage: sync-session.sh <mirror-dir> <project> <session>" >&2; exit 2; }
SRC="$1"; PROJECT="$2"; SESSION="$3"

sa_init
[ -n "$SA_CONFIG" ] || { echo "session-archiver: no config found" >&2; exit 1; }

sa_sync_session "$SRC" "$PROJECT" "$SESSION"
