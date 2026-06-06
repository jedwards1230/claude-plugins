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

# POSIX single-quote-safe quoting: sa_shquote "a'b" -> 'a'\''b'
# Pure-bash char loop — avoids the ${//} replacement-escaping ambiguity.
sa_shquote() {
  local s="$1" c out="'" i len=${#1}
  for (( i=0; i<len; i++ )); do
    c="${s:i:1}"
    if [ "$c" = "'" ]; then out="$out'\\''"; else out="$out$c"; fi
  done
  printf "%s'" "$out"
}

sa_cfg() {
  # sa_cfg '<jq filter>' — read a value from the config file, empty on miss.
  [ -n "$SA_CONFIG" ] && jq -r "$1 // empty" "$SA_CONFIG" 2>/dev/null || true
}

sa_cfg_bool() {
  # sa_cfg_bool <top-level-key> — read a boolean while PRESERVING an explicit
  # `false`. (sa_cfg can't: jq's `//` treats false like null, so
  # `.include_tool_results // empty` yields empty for a configured `false`.)
  # Empty when the key is absent.
  [ -n "$SA_CONFIG" ] && jq -r "if has(\"$1\") then .\"$1\" else empty end" "$SA_CONFIG" 2>/dev/null || true
}

sa_init() {
  # Private by default for every file any entrypoint creates — mirror tree,
  # spool/state/locks, and the log (incl. its rotation .tmp). Transcripts and
  # the log's destination paths must not be world-readable.
  umask 077
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
  v="$(sa_cfg_bool include_subagents)";    [ -n "$v" ] && SA_INCLUDE_SUBAGENTS="$v"
  v="$(sa_cfg_bool include_tool_results)"; [ -n "$v" ] && SA_INCLUDE_TOOL_RESULTS="$v"

  local sp; sp="$(sa_cfg '.spool_dir')"
  if [ -n "$sp" ]; then
    SA_SPOOL="$(sa_expand_tilde "$sp")"
    mkdir -p "$SA_SPOOL" 2>/dev/null || sa_log "warning: cannot create spool_dir '$SA_SPOOL' — spool mode will not persist markers"
  fi
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

# ── Local mirror of one session (shared by the hook and by backfill) ──────────
# The mirror tree is <local_mirror>/<host>/<project>/<session>.
sa_dest_dir() { printf '%s/%s/%s/%s' "$SA_MIRROR" "$SA_HOST" "$1" "$2"; }

# sa_mirror_session <transcript> <project> <uuid> <subdir>
# Copies the transcript (the load-bearing file) plus its optional sidecar dir
# into the local mirror, honoring SA_INCLUDE_SUBAGENTS / SA_INCLUDE_TOOL_RESULTS.
# Returns 0 only if the transcript AND every included sidecar copied — so the
# caller must NOT record the state signature on a non-zero return (a partial
# copy from disk-full / permissions / transient I/O would otherwise be skipped
# forever). Requires sa_init to have populated SA_MIRROR/SA_HOST/SA_INCLUDE_*.
sa_mirror_session() {
  local transcript="$1" project="$2" uuid="$3" subdir="$4"
  # umask 077 so every dir/file created (incl. intermediate host/project dirs)
  # is private — transcripts contain whatever tools read.
  umask 077
  local dest; dest="$(sa_dest_dir "$project" "$uuid")"
  mkdir -p "$dest" 2>/dev/null || { sa_log "cannot create mirror $dest"; return 1; }
  # Tighten perms on every level — umask only governs dirs we create fresh, so a
  # pre-existing intermediate dir with a looser mode would leak the list of
  # archived session IDs to other local users.
  chmod 700 "$SA_MIRROR" "$SA_MIRROR/$SA_HOST" "$SA_MIRROR/$SA_HOST/$project" "$dest" 2>/dev/null || true

  local ok=1
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$transcript" "$dest/" 2>>"$SA_LOG" || ok=0
    if [ -d "$subdir" ]; then
      local EXC=()
      [ "$SA_INCLUDE_SUBAGENTS" = "true" ]    || EXC+=(--exclude 'subagents' --exclude 'subagents/')
      [ "$SA_INCLUDE_TOOL_RESULTS" = "true" ] || EXC+=(--exclude 'tool-results' --exclude 'tool-results/')
      # ${EXC[@]+...} keeps an empty array safe under `set -u` on bash 3.2.
      rsync -a ${EXC[@]+"${EXC[@]}"} "$subdir/" "$dest/" 2>>"$SA_LOG" || ok=0
    fi
  else
    cp -p "$transcript" "$dest/" 2>>"$SA_LOG" || ok=0
    if [ -d "$subdir" ]; then cp -pR "$subdir/." "$dest/" 2>>"$SA_LOG" || ok=0; fi
  fi
  [ "$ok" = 1 ] && return 0 || return 1
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

  # Argument array for direct ssh calls (survives spaces in the key path).
  local sshopts=(-o BatchMode=yes -o ConnectTimeout=10)
  [ -n "$ssh_key" ] && sshopts+=(-i "$ssh_key")
  # rsync -e needs a single string; single-quote the key so spaces survive.
  local rsh="ssh -o BatchMode=yes -o ConnectTimeout=10"
  [ -n "$ssh_key" ] && rsh="$rsh -i $(sa_shquote "$ssh_key")"

  # Classify remote (user@host:/path) vs local. Handle bracketed IPv6 hosts
  # (user@[fe80::1]:/path) and avoid misreading a local path that contains a
  # colon as remote (a remote spec's pre-colon host part has no '/').
  local is_remote=0 hostpart="" pathpart="" pre
  case "$dest" in
    *"]:"*)                       # bracketed IPv6 host
      is_remote=1
      hostpart="${dest%%]:*}]"
      pathpart="${dest#*]:}"
      ;;
    *:*)
      pre="${dest%%:*}"
      case "$pre" in
        */*) is_remote=0 ;;       # colon, but a path before it -> local
        *)   is_remote=1; hostpart="$pre"; pathpart="${dest#*:}" ;;
      esac
      ;;
  esac

  if [ "$is_remote" = 1 ]; then
    # ensure parent exists, then rsync over ssh. Quote the remote path so
    # spaces / single quotes in it can't break the remote shell command.
    ssh "${sshopts[@]}" "$hostpart" "mkdir -p $(sa_shquote "$pathpart")" 2>>"$SA_LOG" || {
      sa_log "target '$name': rsync mkdir FAILED on $hostpart"; return 1; }
    rsync -a -e "$rsh" "$src/" "$dest/" 2>>"$SA_LOG"
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
  # {src} is substituted into a string handed to `bash -c`, so shell-quote it —
  # otherwise a mirror path with spaces/specials would word-split or inject.
  # (host/project/session are sanitized/UUID-shaped; src is the only risk.)
  run="$(sa_render "$tmpl" "$host" "$project" "$session" "$(sa_shquote "$src")" "$dest_key")"
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
  # Refuse to proceed on an unparseable config: otherwise the target loop below
  # would see zero targets and return success, letting a caller de-spool without
  # ever uploading. A parse failure must keep the marker for the next attempt.
  if ! jq -e . "$SA_CONFIG" >/dev/null 2>&1; then
    sa_log "sync: config '$SA_CONFIG' is not valid JSON — refusing to de-spool $session"
    return 1
  fi
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

# ── Local-mirror retention (opt-in) ───────────────────────────────────────────
# Honors .retain_days (delete session dirs older than N days) and .max_size_gb
# (delete oldest session dirs until total mirror size is under the cap). Both
# default to 0/absent = disabled. Rate-limited to at most once per hour. Only
# ever touches the local mirror, never remote copies.
sa_prune_mirror() {
  local days size_gb
  days="$(sa_cfg '.retain_days')";   [ -n "$days" ]    || days=0
  size_gb="$(sa_cfg '.max_size_gb')"; [ -n "$size_gb" ] || size_gb=0
  case "$days" in *[!0-9]*) days=0 ;; esac
  [ "$days" = 0 ] && [ "$size_gb" = 0 ] && return 0
  [ -n "${SA_MIRROR:-}" ] && [ -d "$SA_MIRROR" ] || return 0

  # rate-limit: at most once per hour
  local marker="$SA_STATE/.last-prune" now mt
  now=$(date +%s 2>/dev/null || echo 0)
  mt=$(sa_mtime "$marker")
  [ "$now" -gt 0 ] && [ "$mt" -gt 0 ] && [ $((now - mt)) -lt 3600 ] && return 0
  : > "$marker" 2>/dev/null || true

  if [ "$days" != 0 ]; then
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      rm -rf "$d" 2>/dev/null && sa_log "prune: age>${days}d removed $d"
    done <<EOF
$(find "$SA_MIRROR" -mindepth 3 -maxdepth 3 -type d -mtime +"$days" 2>/dev/null)
EOF
  fi

  [ "$size_gb" != 0 ] && sa_prune_by_size "$size_gb"
  return 0
}

sa_prune_by_size() {
  local size_gb="$1" limit_kb total_kb listfile mt dir dkb
  limit_kb=$(awk "BEGIN{printf \"%d\", ($size_gb)*1048576}" 2>/dev/null || echo 0)
  [ "${limit_kb:-0}" -gt 0 ] || return 0
  total_kb=$(du -sk "$SA_MIRROR" 2>/dev/null | awk '{print $1}')
  [ "${total_kb:-0}" -gt "$limit_kb" ] || return 0

  listfile="$(mktemp -t sa-prune.XXXXXX)" || return 0
  # oldest first: "<mtime>\t<dir>"
  find "$SA_MIRROR" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | while IFS= read -r d; do
    printf '%s\t%s\n' "$(sa_mtime "$d")" "$d"
  done | sort -n > "$listfile"

  while IFS=$'\t' read -r mt dir; do
    [ "${total_kb:-0}" -gt "$limit_kb" ] || break
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    dkb=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
    if rm -rf "$dir" 2>/dev/null; then
      total_kb=$((total_kb - ${dkb:-0}))
      sa_log "prune: size>${size_gb}GB removed $dir"
    fi
  done < "$listfile"
  rm -f "$listfile" 2>/dev/null || true
}
