#!/bin/bash
# SessionStart hook for go-quality.
#
# Two responsibilities:
#   1. In Claude Code Web (CLAUDE_CODE_REMOTE=true), install Go, golangci-lint,
#      and jq into the ephemeral environment. Locally, tools are expected to be
#      pre-installed.
#   2. Probe the environment regardless of remote/local and emit stdout context
#      (read by Claude as a system reminder) when the plugin's hooks would be
#      degraded — missing tools, or Go source without a root module.

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

# Probe 1: missing tools, with per-tool impact messaging.
# Matches the lookup logic the hook scripts actually use.
MISSING_GO=true
MISSING_GOFMT=true
MISSING_GOLANGCI=true
MISSING_JQ=true

command -v go    &>/dev/null && MISSING_GO=false
command -v gofmt &>/dev/null && MISSING_GOFMT=false
command -v jq    &>/dev/null && MISSING_JQ=false

# Mirror go-lint.sh: check $(go env GOPATH)/bin before PATH so a tool installed
# via `go install` is recognized even when GOPATH/bin is not on PATH.
if ! $MISSING_GO; then
  GOPATH_DIR=$(go env GOPATH 2>/dev/null || true)
  if [ -n "$GOPATH_DIR" ] && [ -x "$GOPATH_DIR/bin/golangci-lint" ]; then
    MISSING_GOLANGCI=false
  fi
fi
if $MISSING_GOLANGCI && command -v golangci-lint &>/dev/null; then
  MISSING_GOLANGCI=false
fi

IMPACT_LINES=()
$MISSING_GO && IMPACT_LINES+=("  - go missing — vet, test, and lint hooks all skip; no Go quality gates run this session.")
# Suppress gofmt and golangci-lint impact lines when go is also missing —
# the go-missing line already covers them, and printing both yields a
# contradiction (e.g. "vet/test/lint all skip" + "vet and test still run").
if ! $MISSING_GO; then
  $MISSING_GOFMT    && IMPACT_LINES+=("  - gofmt missing — PostToolUse format hook no-ops; .go edits will NOT be auto-formatted.")
  $MISSING_GOLANGCI && IMPACT_LINES+=("  - golangci-lint missing — Stop-event lint hook skips; go vet and go test still run.")
fi
$MISSING_JQ && IMPACT_LINES+=("  - jq missing — format hook exits early (no auto-format), and vet/test/lint lose their stop_hook_active loop guard.")

if [ ${#IMPACT_LINES[@]} -gt 0 ]; then
  printf '[go-quality] Quality gates degraded — missing tools detected:\n\n'
  for line in "${IMPACT_LINES[@]}"; do
    printf '%s\n' "$line"
  done
  cat <<EOF

Install:
  go:            https://go.dev/dl/
  golangci-lint: https://golangci-lint.run/welcome/install/
  jq:            \`brew install jq\` / \`apt-get install jq\`

Please alert the user about the missing tools so they can install them or
move to an environment that has them — not all chat clients surface hook
output, so a human-readable mention in your next reply is the only way
they'll know.
EOF
fi

# Probe 2: detect repos where the toolchain won't work cleanly.
#
# The Stop hooks dispatch per-module: they walk up from each modified .go
# file to its owning go.mod and run vet/test/lint from that directory. So
# the probe only needs to flag the case where tracked Go source exists but
# NO go.mod / go.work is reachable anywhere — that's the only state where
# the hooks have nothing to dispatch against.
#
# Workspace mode (root go.work) and root-module mode (root go.mod) both
# work cleanly from the root, so stay silent. Multi-module repos with
# nested go.mod files also work via per-module dispatch — emit an info
# message so the assistant knows the gates are active.
#
# We use \`git ls-files\` instead of \`find\` so the probe naturally respects
# .gitignore and nested git boundaries: independently cloned repos under
# this tree (with their own .git dirs) are excluded by git's worktree
# semantics, so we don't false-fire on ops repos that vendor unrelated Go
# projects.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT" ]; then
  # Skip silently if root has go.mod or go.work — toolchain runs from root.
  if [ ! -f "$REPO_ROOT/go.mod" ] && [ ! -f "$REPO_ROOT/go.work" ]; then
    TRACKED_GO=$(cd "$REPO_ROOT" && git ls-files -- '*.go' 2>/dev/null | head -n 1)
    if [ -n "$TRACKED_GO" ]; then
      # Tracked Go but no root module. Look for nested go.mod files.
      NESTED_MODS=$(cd "$REPO_ROOT" && git ls-files 2>/dev/null | grep '/go\.mod$' || true)
      if [ -z "$NESTED_MODS" ]; then
        # No modules anywhere — real problem
        cat <<EOF
[go-quality] Tracked Go source files but no go.mod anywhere in the repo.

The plugin's Stop hooks need a module to run \`go vet\` / \`go test\` /
\`golangci-lint\` against. Either init a module:

  go mod init <module-path>

…or use a workspace (\`go.work\`) if you have multiple modules.

Please alert the user — not all chat clients surface hook output.
EOF
      else
        # Multi-module repo — gates dispatch per-module, friendly info only.
        nested_count=$(printf '%s\n' "$NESTED_MODS" | wc -l | tr -d ' ')
        echo "[go-quality] Multi-module repo detected — $nested_count nested go.mod file(s):"
        printf '%s\n' "$NESTED_MODS" | head -10 | sed 's|^|  - |'
        if [ "$nested_count" -gt 10 ]; then
          echo "  ... ($((nested_count - 10)) more)"
        fi
        echo ""
        echo "Stop hooks will dispatch vet/test/lint per-module on the module owning each modified file. No action needed."
      fi
    fi
    # else: no tracked Go at all — plugin is dormant here, silent.
  fi
  # else: root has go.mod or go.work — toolchain works from root, silent.
fi

exit 0
