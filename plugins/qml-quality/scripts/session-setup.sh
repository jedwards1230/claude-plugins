#!/bin/bash
# SessionStart hook for qml-quality.
#
# Probes the environment and emits stdout context (read by Claude as a system
# reminder) when the plugin's hooks would be degraded — missing tools, or a
# qmlformat version with the known parser regression.
#
# Unlike go-quality, this plugin does NOT auto-install its toolchain in Claude
# Code Web: the Qt QML dev tools (qt6-declarative-dev-tools) are heavy, so we
# warn-only and let the user decide.
set +e  # Never exit on error in session-start

# ---------------------------------------------------------------------------
# Remote (Claude Code Web): warn-only, no install.
# ---------------------------------------------------------------------------
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  if ! command -v qmlformat &>/dev/null; then
    echo "[qml-quality] Running in Claude Code Web — qmlformat is not auto-installed" >&2
    echo "[qml-quality] (Qt QML dev tools are heavy; install manually if QML gates are needed:" >&2
    echo "[qml-quality]  apt-get install -y qt6-declarative-dev-tools jq)" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Probe: missing tools, with per-tool impact messaging.
# ---------------------------------------------------------------------------
MISSING_QMLFORMAT=true
MISSING_QMLLINT=true
MISSING_JQ=true

command -v qmlformat &>/dev/null && MISSING_QMLFORMAT=false
command -v qmllint   &>/dev/null && MISSING_QMLLINT=false
command -v jq        &>/dev/null && MISSING_JQ=false

IMPACT_LINES=()
$MISSING_QMLFORMAT && IMPACT_LINES+=("  - qmlformat missing — format auto-fix (PostToolUse) and the Stop-event format check both skip; no QML formatting gates run this session.")
if ! $MISSING_QMLFORMAT; then
  $MISSING_QMLLINT && IMPACT_LINES+=("  - qmllint missing — the warn-only lint pass is skipped (formatting check still runs).")
fi
$MISSING_JQ && IMPACT_LINES+=("  - jq missing — PostToolUse format hook exits early (no auto-format), and the check hook loses its stop_hook_active loop guard.")

if [ ${#IMPACT_LINES[@]} -gt 0 ]; then
  printf '[qml-quality] Quality gates degraded — missing tools detected:\n\n'
  for line in "${IMPACT_LINES[@]}"; do
    printf '%s\n' "$line"
  done
  cat <<'EOF'

Install (provides qmlformat + qmllint):
  macOS:  brew install qt
  Debian: apt-get install -y qt6-declarative-dev-tools
  jq:     brew install jq / apt-get install jq

Please alert the user about the missing tools so they can install them — not
all chat clients surface hook output, so a human-readable mention in your next
reply is the only way they'll know.
EOF
fi

# ---------------------------------------------------------------------------
# Probe: qmlformat parser regression (6.11.x).
# ---------------------------------------------------------------------------
if ! $MISSING_QMLFORMAT; then
  QMLFORMAT_VER=$(qmlformat --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  case "$QMLFORMAT_VER" in
    6.11.*)
      cat <<EOF
[qml-quality] qmlformat $QMLFORMAT_VER has a known parser regression — it fails
to parse some valid QML files (exits non-zero) that older Qt (e.g. CI's 6.8.3)
handles fine. The plugin's hooks are designed for this: a parse error never
blocks — the file is skipped with a note, and only files that parse cleanly and
are provably unformatted will fail the check. No action needed; just be aware a
"could not parse" note is expected, not a real failure.
EOF
      ;;
  esac
fi

exit 0
