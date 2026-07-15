#!/bin/bash
# SessionStart hook for swift-quality.
#
# Probe-only: unlike the rust/go siblings there is no remote install step —
# the Swift toolchain the gates need (swift, xcodebuild, simulators) is
# Apple-platform tooling that can't be installed into the Linux-based Claude
# Code Web environment. On a remote host the plugin is effectively dormant;
# say so once and exit.
#
# Probes run locally and emit stdout context (read by Claude as a system
# reminder) when the plugin's hooks would be degraded — missing tools, missing
# opt-in configs — plus a one-time note about the app-target gate that
# deliberately lives in CI, not in Stop hooks.

set +e # Never exit on error in session-start

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  echo "[swift-quality] Remote (Linux) environment — Swift/Xcode tooling unavailable; quality gates are dormant this session." >&2
  exit 0
fi

# Detect whether this repo actually contains any tracked Swift source. The
# hooks all self-gate by file extension, so in a repo with zero Swift code the
# plugin is dormant — no point nagging about missing Swift tooling.
#
# `git ls-files` respects .gitignore and nested git boundaries, so
# independently cloned repos under this tree are excluded. Outside a git repo,
# fall back to a depth-limited find that won't hang on huge trees.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
HAS_SWIFT_FILES=false
if [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT" ]; then
  [ -n "$(cd "$REPO_ROOT" && git ls-files -- '*.swift' 2>/dev/null | head -n 1)" ] && HAS_SWIFT_FILES=true
else
  [ -n "$(find . -maxdepth 4 -name '*.swift' -not -path '*/.git/*' -print -quit 2>/dev/null)" ] && HAS_SWIFT_FILES=true
fi

$HAS_SWIFT_FILES || exit 0

# ---------------------------------------------------------------------------
# Probe 1: missing tools / missing opt-in configs, with per-item impact.
# Matches the lookup logic the hook scripts actually use.
# ---------------------------------------------------------------------------
IMPACT_LINES=()

if ! command -v swift &>/dev/null; then
  IMPACT_LINES+=("  - swift missing — the per-package swift test gate skips; no build/test checks run this session.")
fi

if ! command -v jq &>/dev/null; then
  IMPACT_LINES+=("  - jq missing — format hook exits early (no auto-format), and test/lint lose their stop_hook_active loop guard.")
fi

HAS_SWIFTLINT_CONFIG=false
[ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/.swiftlint.yml" ] && HAS_SWIFTLINT_CONFIG=true
if $HAS_SWIFTLINT_CONFIG && ! command -v swiftlint &>/dev/null; then
  IMPACT_LINES+=("  - swiftlint missing but the repo has .swiftlint.yml — the lint gate skips; install swiftlint to enforce it.")
fi

# Formatter configs are the opt-in for the PostToolUse auto-format hook.
HAS_SWIFTFORMAT_CONFIG=false
HAS_APPLE_FORMAT_CONFIG=false
if [ -n "$REPO_ROOT" ]; then
  [ -n "$(cd "$REPO_ROOT" && git ls-files 2>/dev/null | grep -E '(^|/)\.swiftformat$' | head -n 1)" ] && HAS_SWIFTFORMAT_CONFIG=true
  [ -n "$(cd "$REPO_ROOT" && git ls-files 2>/dev/null | grep -E '(^|/)\.swift-format$' | head -n 1)" ] && HAS_APPLE_FORMAT_CONFIG=true
fi
if $HAS_SWIFTFORMAT_CONFIG && ! command -v swiftformat &>/dev/null; then
  IMPACT_LINES+=("  - swiftformat missing but the repo has a .swiftformat config — .swift edits will NOT be auto-formatted.")
fi
if $HAS_APPLE_FORMAT_CONFIG && ! command -v swift-format &>/dev/null && ! command -v swift &>/dev/null; then
  IMPACT_LINES+=("  - swift-format missing but the repo has a .swift-format config — .swift edits will NOT be auto-formatted.")
fi

if [ ${#IMPACT_LINES[@]} -gt 0 ]; then
  printf '[swift-quality] Quality gates degraded — missing tools detected:\n\n'
  for line in "${IMPACT_LINES[@]}"; do
    printf '%s\n' "$line"
  done
  cat <<'EOF'

Install:
  swift/xcodebuild: Xcode (App Store) or Command Line Tools (`xcode-select --install`)
  swiftlint:        `brew install swiftlint`
  swiftformat:      `brew install swiftformat`
  jq:               `brew install jq`

Please alert the user about the missing tools so they can install them or
move to an environment that has them — not all chat clients surface hook
output, so a human-readable mention in your next reply is the only way
they'll know.
EOF
fi

# ---------------------------------------------------------------------------
# Probe 2: explain the gate split for Xcode-app repos.
#
# The Stop hooks only build/test SPM packages (fast, host-runnable). Files
# owned by an .xcodeproj app target need xcodebuild + a simulator — minutes
# per run, so that gate deliberately lives in CI. Tell the assistant so it
# runs the CI-mirroring build before handing off a PR that touches app code.
# ---------------------------------------------------------------------------
if [ -n "$REPO_ROOT" ]; then
  XCODEPROJ=$(cd "$REPO_ROOT" && find . -maxdepth 2 -name '*.xcodeproj' -print -quit 2>/dev/null)
  if [ -n "$XCODEPROJ" ]; then
    cat <<EOF
[swift-quality] Xcode app project detected ($XCODEPROJ). Stop hooks gate SPM
packages only — app-target Swift files are NOT built by hooks (xcodebuild +
simulator is too slow for a per-turn gate). Before handing off a PR that
touches app-target code, run the repo's CI build/test commands (see its CI
workflow) yourself, e.g. xcodebuild build-for-testing / test-without-building
against the simulator destination CI uses.
EOF
  fi
fi

exit 0
