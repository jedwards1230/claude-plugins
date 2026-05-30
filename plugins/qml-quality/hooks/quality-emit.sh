# shellcheck shell=bash
# Bounded tool-output emitter, shared by the *-quality plugins.
#
# NOTE: This file is intentionally duplicated verbatim into each quality
# plugin's hooks/ dir — plugins must be self-contained, so do NOT cross-
# reference it between plugins. Keep the copies identical.
#
# Why: on a check FAILURE the Stop hooks would otherwise dump the ENTIRE tool
# output to stderr, which Claude surfaces as Stop feedback — hundreds of lines,
# every Stop. emit_bounded writes the full output to a log file under the
# plugin's persistent data dir and emits only the first N lines to stderr,
# followed by a footer pointing at the log + a reproduce command.
#
# N is configurable via the CLAUDE_PLUGIN_OPTION_MAX_LINES plugin option or the
# CLAUDE_QUALITY_MAX_LINES env var (default 200).
#
# Log location: ${CLAUDE_PLUGIN_DATA}, the sanctioned persistent per-plugin dir
# (~/.claude/plugins/data/{id}/), auto-created by the host. ${CLAUDE_PLUGIN_ROOT}
# is ephemeral — never write logs there. The ${TMPDIR:-/tmp} fallback covers
# older hosts that don't set CLAUDE_PLUGIN_DATA.
#
# Reads the full output from stdin.
#   usage:  some_command 2>&1 | emit_bounded "<logname>" "<reproduce cmd>"
emit_bounded() {
  local logname="$1" reproduce="$2"
  local max="${CLAUDE_PLUGIN_OPTION_MAX_LINES:-${CLAUDE_QUALITY_MAX_LINES:-200}}"
  local dir="${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}}"
  mkdir -p "$dir" 2>/dev/null || true
  local logfile="$dir/$logname"
  cat > "$logfile"
  local total
  total="$(wc -l < "$logfile" | tr -d ' ')"
  head -n "$max" "$logfile" >&2
  if [ "${total:-0}" -gt "$max" ]; then
    {
      echo ""
      echo "... output truncated: showing first ${max} of ${total} lines."
      echo "Full output: cat \"${logfile}\""
      echo "Re-run:      ${reproduce}"
    } >&2
  fi
}
