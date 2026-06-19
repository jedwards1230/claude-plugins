#!/bin/bash
# SessionStart hook for tofu-quality.
#
# Two responsibilities:
#   1. In Claude Code Web (CLAUDE_CODE_REMOTE=true), install the OpenTofu CLI
#      (a single static binary) and jq into the ephemeral environment so the
#      format gates work out of the box. Locally, tools are expected to be
#      pre-installed.
#   2. Probe the environment regardless of remote/local and emit stdout context
#      (read by Claude as a system reminder) when the plugin's hooks would be
#      degraded — missing tools.

set +e  # Never exit on error in session-start

# ---------------------------------------------------------------------------
# Install step (remote only)
# ---------------------------------------------------------------------------
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  echo "[tofu-quality] Running in Claude Code Web — checking tools..." >&2

  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  TOFU_ARCH="amd64" ;;
    aarch64) TOFU_ARCH="arm64" ;;
    arm64)   TOFU_ARCH="arm64" ;;
    *)
      echo "[tofu-quality] WARNING: unsupported architecture $ARCH — skipping tool install" >&2
      TOFU_ARCH=""
      ;;
  esac

  # jq is required by the hook scripts for stdin JSON parsing (loop guards).
  if ! command -v jq &>/dev/null; then
    echo "[tofu-quality] Installing jq..." >&2
    apt-get update >/dev/null 2>&1 && apt-get install -y jq >/dev/null 2>&1 || \
      echo "[tofu-quality] WARNING: jq install failed — hooks may not work" >&2
  fi

  # OpenTofu: download the release tarball, verify its SHA256 against the
  # signed checksums file, and drop the binary on PATH.
  if [ -n "$TOFU_ARCH" ] && ! command -v tofu &>/dev/null; then
    echo "[tofu-quality] Installing OpenTofu..." >&2
    TOFU_VERSION=1.11.5
    TOFU_ARCHIVE="tofu_${TOFU_VERSION}_linux_${TOFU_ARCH}.tar.gz"
    TOFU_BASE="https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}"
    TOFU_TMPDIR=$(mktemp -d)
    if curl -fsSL "${TOFU_BASE}/${TOFU_ARCHIVE}" -o "${TOFU_TMPDIR}/${TOFU_ARCHIVE}" \
      && curl -fsSL "${TOFU_BASE}/tofu_${TOFU_VERSION}_SHA256SUMS" -o "${TOFU_TMPDIR}/SHA256SUMS" \
      && (cd "${TOFU_TMPDIR}" && grep "  ${TOFU_ARCHIVE}$" SHA256SUMS | sha256sum -c -) >/dev/null 2>&1 \
      && tar -xzf "${TOFU_TMPDIR}/${TOFU_ARCHIVE}" -C "${TOFU_TMPDIR}" \
      && install -m 0755 "${TOFU_TMPDIR}/tofu" /usr/local/bin/tofu; then
      echo "[tofu-quality] OpenTofu ${TOFU_VERSION} installed" >&2
    else
      echo "[tofu-quality] WARNING: OpenTofu install failed — format/validate gates will skip" >&2
    fi
    rm -rf "${TOFU_TMPDIR}"
  fi

  echo "[tofu-quality] Install step done" >&2
fi

# ---------------------------------------------------------------------------
# Probe: missing tools, with per-tool impact messaging.
# ---------------------------------------------------------------------------

# Detect whether this repo actually contains any tracked OpenTofu/Terraform
# source. The plugin's hooks all self-gate by file extension (the
# PostToolUse/Stop hooks no-op when no .tf/.tofu/.tfvars files were modified),
# so in a repo with zero IaC the plugin is dormant — there's no point nagging
# about missing tofu/jq.
#
# We use `git ls-files` so the check respects .gitignore and nested git
# boundaries: independently cloned repos under this tree (with their own .git
# dirs) are excluded by git's worktree semantics, so we don't false-fire on
# ops repos that vendor unrelated Terraform projects. Outside a git repo we
# fall back to a depth-limited `find` that won't hang on huge trees.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
HAS_TF_FILES=false
if [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT" ]; then
  [ -n "$(cd "$REPO_ROOT" && git ls-files -- '*.tf' '*.tofu' '*.tfvars' 2>/dev/null | head -n 1)" ] && HAS_TF_FILES=true
else
  [ -n "$(find . -maxdepth 4 \( -name '*.tf' -o -name '*.tofu' -o -name '*.tfvars' \) -not -path '*/.git/*' -print -quit 2>/dev/null)" ] && HAS_TF_FILES=true
fi

MISSING_TOFU=true
MISSING_JQ=true

command -v tofu &>/dev/null && MISSING_TOFU=false
command -v jq   &>/dev/null && MISSING_JQ=false

IMPACT_LINES=()
$MISSING_TOFU && IMPACT_LINES+=("  - tofu missing — format auto-fix (PostToolUse), the Stop format check, and validate all skip; no OpenTofu quality gates run this session.")
$MISSING_JQ && IMPACT_LINES+=("  - jq missing — PostToolUse format hook exits early (no auto-format), and the check/validate hooks lose their stop_hook_active loop guard.")

# Only emit when the repo actually has OpenTofu/Terraform source — otherwise
# the plugin is dormant and the warning is pure noise (e.g. in an Ansible repo).
if $HAS_TF_FILES && [ ${#IMPACT_LINES[@]} -gt 0 ]; then
  printf '[tofu-quality] Quality gates degraded — missing tools detected:\n\n'
  for line in "${IMPACT_LINES[@]}"; do
    printf '%s\n' "$line"
  done
  cat <<'EOF'

Install:
  tofu:  https://opentofu.org/docs/intro/install/  (macOS: brew install opentofu)
  jq:    brew install jq / apt-get install jq

Please alert the user about the missing tools so they can install them or
move to an environment that has them — not all chat clients surface hook
output, so a human-readable mention in your next reply is the only way
they'll know.
EOF
fi

exit 0
