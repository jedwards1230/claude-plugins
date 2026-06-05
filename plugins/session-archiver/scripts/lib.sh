# shellcheck shell=bash
# Shared library for the session-archiver plugin.
#
# Sourced by:
#   hooks/archive.sh        (Stage 1: runs inside Claude Code hooks)
#   scripts/sync-session.sh (pushes one mirrored session to remote targets)
#   scripts/drain.sh        (Stage 2: drains the spool; run standalone by a timer)
#
# Portability contract (verified targets: macOS bash 3.2, Linux bash 4+):
#   Hard deps : jq, rsync, POSIX coreutils.
#   NOT assumed: flock, timeout/gtimeout, rclone, yq, GNU sed.
# Everything here must work when CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA are
# UNSET (drain.sh runs from launchd/systemd, outside Claude Code).

set -u

# ── Data/config locations (independent of Claude Code env) ────────────────────
sa_data_dir() {
  # Persistent state: spool, locks, last-synced markers, log.
  if [ -n "${SESSION_ARCHIVER_DATA:-}" ]; then
    printf '%s' "$SESSION_ARCHIVER_DATA"
  elif [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
    printf '%s' "$CLAUDE_PLUGIN_DATA"
  else
    printf '%s' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/session-archiver"
  fi
}

sa_config_file() {
  # First existing wins.
  local c
  if [ -n "${SESSION_ARCHIVER_CONFIG:-}" ] && [ -f "${SESSION_ARCHIVER_CONFIG}" ]; then
    printf '%s' "$SESSION_ARCHIVER_CONFIG"; return 0
  fi
  c="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/session-archiver/config.json"
  [ -f "$c" ] && { printf '%s' "$c"; return 0; }
  c="$(sa_data_dir)/config.json"
  [ -f "$c" ] && { printf '%s' "$c"; return 0; }
  return 1
}

# ── Globals populated by sa_init ──────────────────────────────────────────────
SA_CONFIG=""; SA_DATA=""; SA_SPOOL=""; SA_LOCKS=""; SA_STATE=""; SA_LOG=""
SA_ENABLED="false"; SA_MIRROR=""; SA_MODE="local-only"
SA_INCLUDE_SUBAGENTS="true"; SA_INCLUDE_TOOL_RESULTS="true"
SA_HOST=""

sa_expand_tilde() {
  case "$1" in
    "~"/*) printf '%s' "$HOME/${1#\~/}" ;;
    "~")   printf '%s' "$HOME" ;;
    *)     printf '%s' "$1" ;;
  esac
}

sa_cfg() {
  # sa_cfg '<jq filter>' — read a value from the config file, empty on miss.
  [ -n "$SA_CONFIG" ] && jq -r "$1 // empty" "$SA_CONFIG" 2>/dev/null || true
}

sa_init() {
  SA_DATA="$(sa_data_dir)"
  SA_SPOOL="$SA_DATA/spool"
  SA_LOCKS="$SA_DATA/locks"
  SA_STATE="$SA_DATA/state"
  SA_LOG="$SA_DATA/archive.log"
  mkdir -p "$SA_SPOOL" "$SA_LOCKS" "$SA_STATE" 2>/dev/null || true

  SA_HOST="${SESSION_ARCHIVER_HOST:-}"
  [ -n "$SA_HOST" ] || SA_HOST="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)"
  # sanitize host for use in paths/keys
  SA_HOST="$(printf '%s' "$SA_HOST" | tr -c 'A-Za-z0-9._-' '-')"

  if SA_CONFIG="$(sa_config_file)"; then :; else SA_CONFIG=""; fi
  if [ -z "$SA_CONFIG" ]; then SA_ENABLED="false"; return 0; fi

  # env override beats config file for the master switch
  if [ -n "${SESSION_ARCHIVER_ENABLED:-}" ]; then
    SA_ENABLED="$SESSION_ARCHIVER_ENABLED"
  else
    SA_ENABLED="$(sa_cfg '.enabled')"; [ -n "$SA_ENABLED" ] || SA_ENABLED="false"
  fi

  SA_MIRROR="$(sa_cfg '.local_mirror')"; [ -n "$SA_MIRROR" ] || SA_MIRROR="$HOME/claude-archives"
  SA_MIRROR="$(sa_expand_tilde "$SA_MIRROR")"

  SA_MODE="${SESSION_ARCHIVER_MODE:-$(sa_cfg '.sync_mode')}"; [ -n "$SA_MODE" ] || SA_MODE="local-only"

  local v
  v="$(sa_cfg '.include_subagents')";    [ -n "$v" ] && SA_INCLUDE_SUBAGENTS="$v"
  v="$(sa_cfg '.include_tool_results')"; [ -n "$v" ] && SA_INCLUDE_TOOL_RESULTS="$v"

  local sp; sp="$(sa_cfg '.spool_dir')"
  [ -n "$sp" ] && SA_SPOOL="$(sa_expand_tilde "$sp")" && mkdir -p "$SA_SPOOL" 2>/dev/null || true
}

# ── Logging (best-effort, never fatal) ────────────────────────────────────────
sa_log() {
  [ -n "$SA_LOG" ] || return 0
  printf '[%s] [%s] %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$$" "$*" >> "$SA_LOG" 2>/dev/null || true
  # keep the log from growing unbounded (~2MB cap, trim to last 1000 lines)
  local sz
  sz=$(wc -c < "$SA_LOG" 2>/dev/null || echo 0)
  if [ "${sz:-0}" -gt 2000000 ]; then
    tail -n 1000 "$SA_LOG" > "$SA_LOG.tmp" 2>/dev/null && mv "$SA_LOG.tmp" "$SA_LOG" 2>/dev/null || true
  fi
}

# ── Locking (mkdir-based; flock is not available on macOS) ─────────────────────
SA_LOCK_STALE_SECONDS=1800
sa_acquire_lock() {
  # sa_acquire_lock <key> -> 0 if acquired, 1 if held by someone else
  local key="$1" d="$SA_LOCKS/$1.lock"
  if mkdir "$d" 2>/dev/null; then return 0; fi
  # reclaim a stale lock
  local now mt age
  now=$(date +%s 2>/dev/null || echo 0)
  mt=$(sa_mtime "$d")
  age=$(( now - mt ))
  if [ "$mt" -gt 0 ] && [ "$age" -gt "$SA_LOCK_STALE_SECONDS" ]; then
    rmdir "$d" 2>/dev/null || true
    mkdir "$d" 2>/dev/null && return 0
  fi
  return 1
}
sa_release_lock() { rmdir "$SA_LOCKS/$1.lock" 2>/dev/null || true; }

# ── Portable mtime / size ─────────────────────────────────────────────────────
sa_mtime() {
  # epoch seconds of a path's mtime, 0 on miss. BSD vs GNU stat.
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}
sa_size() {
  stat -f %z "$1" 2>/dev/null || stat -c %s "$1" 2>/dev/null || echo 0
}

# ── Placeholder rendering ─────────────────────────────────────────────────────
# Replaces {host} {project} {session} {src} {dest_key} in a template.
sa_render() {
  local t="$1" host="$2" project="$3" session="$4" src="$5" dest_key="$6"
  t="${t//\{host\}/$host}"
  t="${t//\{project\}/$project}"
  t="${t//\{session\}/$session}"
  t="${t//\{src\}/$src}"
  t="${t//\{dest_key\}/$dest_key}"
  printf '%s' "$t"
}

# ── Remote target dispatch ────────────────────────────────────────────────────
# sa_push_target <target-json> <src-dir> <host> <project> <session>
# Returns 0 on success, non-zero on failure.
sa_push_target() {
  local tj="$1" src="$2" host="$3" project="$4" session="$5"
  local name type
  name="$(printf '%s' "$tj" | jq -r '.name // "unnamed"')"
  type="$(printf '%s' "$tj" | jq -r '.type // empty')"
  local dest_key
  dest_key="$(sa_render "$(printf '%s' "$tj" | jq -r '.prefix // "{host}/{project}/{session}"')" \
              "$host" "$project" "$session" "$src" "")"

  case "$type" in
    s3)       sa_push_s3      "$tj" "$src" "$dest_key" "$name" ;;
    rsync)    sa_push_rsync   "$tj" "$src" "$host" "$project" "$session" "$name" ;;
    command)  sa_push_command "$tj" "$src" "$host" "$project" "$session" "$dest_key" "$name" ;;
    *)        sa_log "target '$name': unknown type '$type' — skipped"; return 1 ;;
  esac
}

sa_push_s3() {
  local tj="$1" src="$2" dest_key="$3" name="$4"
  command -v aws >/dev/null 2>&1 || { sa_log "target '$name': aws CLI not found — skipped"; return 1; }
  local bucket endpoint profile region path_style
  bucket="$(printf '%s' "$tj"   | jq -r '.bucket // empty')"
  endpoint="$(printf '%s' "$tj" | jq -r '.endpoint_url // empty')"
  profile="$(printf '%s' "$tj"  | jq -r '.aws_profile // empty')"
  region="$(printf '%s' "$tj"   | jq -r '.region // empty')"
  path_style="$(printf '%s' "$tj" | jq -r '.path_style // false')"
  [ -n "$bucket" ] || { sa_log "target '$name': missing bucket — skipped"; return 1; }

  local args; args=(s3 sync "$src" "s3://$bucket/$dest_key/" --only-show-errors --no-progress)
  [ -n "$endpoint" ] && args+=(--endpoint-url "$endpoint")
  [ -n "$region" ]   && args+=(--region "$region")

  # Run with credentials scoped to this invocation. Metadata lookups disabled so
  # a missing IMDS endpoint can't hang the hook.
  (
    export AWS_EC2_METADATA_DISABLED=true
    [ -n "$profile" ] && export AWS_PROFILE="$profile"
    [ "$path_style" = "true" ] && export AWS_S3_ADDRESSING_STYLE=path
    aws "${args[@]}"
  )
  local rc=$?
  [ $rc -eq 0 ] && sa_log "target '$name': s3 sync ok -> s3://$bucket/$dest_key/" \
                || sa_log "target '$name': s3 sync FAILED rc=$rc"
  return $rc
}

sa_push_rsync() {
  local tj="$1" src="$2" host="$3" project="$4" session="$5" name="$6"
  command -v rsync >/dev/null 2>&1 || { sa_log "target '$name': rsync not found — skipped"; return 1; }
  local dest ssh_key
  dest="$(sa_render "$(printf '%s' "$tj" | jq -r '.dest // empty')" "$host" "$project" "$session" "$src" "")"
  ssh_key="$(printf '%s' "$tj" | jq -r '.ssh_key // empty')"
  [ -n "$dest" ] || { sa_log "target '$name': missing dest — skipped"; return 1; }
  ssh_key="$(sa_expand_tilde "$ssh_key")"

  local sshcmd="ssh -o BatchMode=yes -o ConnectTimeout=10"
  [ -n "$ssh_key" ] && sshcmd="$sshcmd -i $ssh_key"

  if printf '%s' "$dest" | grep -q ':'; then
    # remote: user@host:/path — ensure parent exists, then rsync over ssh
    local hostpart pathpart
    hostpart="${dest%%:*}"; pathpart="${dest#*:}"
    $sshcmd "$hostpart" "mkdir -p '$pathpart'" 2>>"$SA_LOG" || {
      sa_log "target '$name': rsync mkdir FAILED on $hostpart"; return 1; }
    rsync -a -e "$sshcmd" "$src/" "$dest/" 2>>"$SA_LOG"
  else
    # local path (e.g. an NFS mount)
    mkdir -p "$dest" 2>/dev/null || { sa_log "target '$name': cannot mkdir $dest — skipped"; return 1; }
    rsync -a "$src/" "$dest/" 2>>"$SA_LOG"
  fi
  local rc=$?
  [ $rc -eq 0 ] && sa_log "target '$name': rsync ok -> $dest" || sa_log "target '$name': rsync FAILED rc=$rc"
  return $rc
}

sa_push_command() {
  local tj="$1" src="$2" host="$3" project="$4" session="$5" dest_key="$6" name="$7"
  local tmpl run
  tmpl="$(printf '%s' "$tj" | jq -r '.run // empty')"
  [ -n "$tmpl" ] || { sa_log "target '$name': missing run command — skipped"; return 1; }
  run="$(sa_render "$tmpl" "$host" "$project" "$session" "$src" "$dest_key")"
  # Expose the same fields as env vars too, for commands that prefer them.
  (
    export SA_SRC="$src" SA_HOST="$host" SA_PROJECT="$project" SA_SESSION="$session" SA_DEST_KEY="$dest_key"
    bash -c "$run"
  ) >>"$SA_LOG" 2>&1
  local rc=$?
  [ $rc -eq 0 ] && sa_log "target '$name': command ok" || sa_log "target '$name': command FAILED rc=$rc"
  return $rc
}

# ── Push one mirrored session to every enabled target ─────────────────────────
# sa_sync_session <mirror-src-dir> <project> <session>
# Returns 0 only if ALL enabled targets succeeded (so callers can safely
# de-spool only on full success). 0 enabled targets => success (nothing to do).
sa_sync_session() {
  local src="$1" project="$2" session="$3"
  [ -d "$src" ] || { sa_log "sync: source missing $src"; return 1; }
  sa_acquire_lock "sync-$session" || { sa_log "sync: $session already syncing — skip"; return 1; }

  local all_ok=0 count=0 tj
  # Heredoc (not a pipe) so the loop runs in this shell and all_ok survives.
  while IFS= read -r tj; do
    [ -n "$tj" ] || continue
    count=$((count + 1))
    sa_push_target "$tj" "$src" "$SA_HOST" "$project" "$session" || all_ok=1
  done <<EOF
$(jq -c '.targets[]? | select(.enabled == true)' "$SA_CONFIG" 2>/dev/null)
EOF

  sa_release_lock "sync-$session"
  [ "$count" -eq 0 ] && sa_log "sync: $session — no enabled remote targets"
  return $all_ok
}
