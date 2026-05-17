#!/bin/bash
# SessionStart hook for go-quality.
#
# Two responsibilities:
#   1. In Claude Code Web (CLAUDE_CODE_REMOTE=true), install Go, golangci-lint,
#      and jq into the ephemeral environment. Locally, tools are expected to be
#      pre-installed.
#   2. Probe the environment regardless of remote/local and emit stdout context
#      (read by Claude as a system reminder) when the plugin's hooks would be
#      degraded — missing tools, or Go source without a module.

set +e  # Never exit on error in session-start

# ---------------------------------------------------------------------------
# Install step (remote only)
# ---------------------------------------------------------------------------
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  echo "[go-quality] Running in Claude Code Web — checking tools..." >&2

  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  GOARCH="amd64" ;;
    aarch64) GOARCH="arm64" ;;
    arm64)   GOARCH="arm64" ;;
    *)
      echo "[go-quality] WARNING: unsupported architecture $ARCH — skipping tool install" >&2
      GOARCH=""
      ;;
  esac

  export PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

  if [ -n "$GOARCH" ]; then
    # jq is required by all hook scripts for stdin JSON parsing
    if ! command -v jq &>/dev/null; then
      echo "[go-quality] Installing jq..." >&2
      apt-get update >/dev/null 2>&1 && apt-get install -y jq >/dev/null 2>&1 || \
        echo "[go-quality] WARNING: jq install failed — hooks may not work" >&2
    fi

    # Go toolchain
    if ! command -v go &>/dev/null; then
      echo "[go-quality] Installing Go..." >&2
      GO_VERSION=1.24.3
      GO_ARCHIVE="go${GO_VERSION}.linux-${GOARCH}.tar.gz"
      GO_TMPDIR=$(mktemp -d)
      if curl -fsSL "https://go.dev/dl/${GO_ARCHIVE}" -o "${GO_TMPDIR}/${GO_ARCHIVE}" \
        && curl -fsSL "https://go.dev/dl/${GO_ARCHIVE}.sha256" -o "${GO_TMPDIR}/${GO_ARCHIVE}.sha256" \
        && printf "%s  %s\n" "$(cat "${GO_TMPDIR}/${GO_ARCHIVE}.sha256")" "${GO_TMPDIR}/${GO_ARCHIVE}" | sha256sum -c - >/dev/null 2>&1 \
        && tar -xzf "${GO_TMPDIR}/${GO_ARCHIVE}" -C /usr/local; then
        ln -sf /usr/local/go/bin/go /usr/local/bin/go 2>/dev/null || true
        ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt 2>/dev/null || true
      else
        echo "[go-quality] WARNING: Go install failed" >&2
      fi
      rm -rf "${GO_TMPDIR}"
    fi

    # golangci-lint
    if ! command -v golangci-lint &>/dev/null; then
      echo "[go-quality] Installing golangci-lint..." >&2
      GOLANGCI_VERSION=2.8.0
      GOLANGCI_ARCHIVE="golangci-lint-${GOLANGCI_VERSION}-linux-${GOARCH}.tar.gz"
      GOLANGCI_TMPDIR=$(mktemp -d)
      if curl -fsSL "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_VERSION}/${GOLANGCI_ARCHIVE}" \
          -o "${GOLANGCI_TMPDIR}/${GOLANGCI_ARCHIVE}" \
        && curl -fsSL "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_VERSION}/checksums.txt" \
          -o "${GOLANGCI_TMPDIR}/checksums.txt" \
        && grep "  ${GOLANGCI_ARCHIVE}$" "${GOLANGCI_TMPDIR}/checksums.txt" | (cd "${GOLANGCI_TMPDIR}" && sha256sum -c -) >/dev/null 2>&1 \
        && tar -xzf "${GOLANGCI_TMPDIR}/${GOLANGCI_ARCHIVE}" -C "${GOLANGCI_TMPDIR}" \
        && mv "${GOLANGCI_TMPDIR}/golangci-lint-${GOLANGCI_VERSION}-linux-${GOARCH}/golangci-lint" /usr/local/bin/; then
        true
      else
        echo "[go-quality] WARNING: golangci-lint install failed" >&2
      fi
      rm -rf "${GOLANGCI_TMPDIR}"
    fi
  fi

  echo "[go-quality] Install step done" >&2
fi

# ---------------------------------------------------------------------------
# Probes (always run; stdout is injected into Claude's context)
# ---------------------------------------------------------------------------

# Probe 1: missing tools
MISSING=()
command -v go &>/dev/null            || MISSING+=("go")
command -v gofmt &>/dev/null         || MISSING+=("gofmt")
command -v golangci-lint &>/dev/null || MISSING+=("golangci-lint")

if [ ${#MISSING[@]} -gt 0 ]; then
  cat <<EOF
[go-quality] Quality gates degraded — missing tools: ${MISSING[*]}

The PostToolUse format hook (gofmt) and the Stop-event vet/test/lint hooks
will silently skip when these tools are absent, so Go code written this
session will not be auto-checked.

Install:
  go:            https://go.dev/dl/
  golangci-lint: https://golangci-lint.run/welcome/install/

Please alert the user about the missing tools so they can install them or
move to an environment that has them — not all chat clients surface hook
output, so a human-readable mention in your next reply is the only way
they'll know.
EOF
fi

# Probe 2: Go source files present but no module manifest anywhere in the repo
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT" ]; then
  HAS_GO_FILES=$(find "$REPO_ROOT" -maxdepth 4 -name '*.go' \
    -not -path '*/vendor/*' \
    -not -path '*/.git/*' \
    -not -path '*/node_modules/*' \
    -print -quit 2>/dev/null)
  if [ -n "$HAS_GO_FILES" ]; then
    HAS_GO_MOD=$(find "$REPO_ROOT" -maxdepth 4 -name 'go.mod' \
      -not -path '*/vendor/*' \
      -not -path '*/.git/*' \
      -not -path '*/node_modules/*' \
      -print -quit 2>/dev/null)
    if [ -z "$HAS_GO_MOD" ]; then
      cat <<EOF
[go-quality] Go source files detected but no go.mod found in this repository.

The plugin's vet, test, and lint hooks operate on a Go module and will fail
on every Stop event until a module is initialized:

  go mod init <module-path>

Please alert the user that the Go module is missing — not all chat clients
surface hook output, so a human-readable mention in your next reply is the
only way they'll know.
EOF
    fi
  fi
fi

exit 0
