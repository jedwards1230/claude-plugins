#!/bin/bash
# Install Go development tools in ephemeral environments (Claude Code Web).
# In local devcontainers, tools are pre-installed via Dockerfile.

set +e  # Never exit on error in session-start

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

echo "[go-quality] Running in Claude Code Web — checking tools..." >&2

export PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

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
  if ! curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -xz -C /usr/local; then
    echo "[go-quality] WARNING: Go install failed" >&2
  fi
fi

# golangci-lint
if ! command -v golangci-lint &>/dev/null; then
  echo "[go-quality] Installing golangci-lint..." >&2
  GOLANGCI_VERSION=2.8.0
  if ! (curl -fsSL "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_VERSION}/golangci-lint-${GOLANGCI_VERSION}-linux-amd64.tar.gz" \
    -o /tmp/golangci-lint.tar.gz \
    && tar -xzf /tmp/golangci-lint.tar.gz -C /tmp \
    && mv "/tmp/golangci-lint-${GOLANGCI_VERSION}-linux-amd64/golangci-lint" /usr/local/bin/ \
    && rm -rf /tmp/golangci-lint*); then
    echo "[go-quality] WARNING: golangci-lint install failed" >&2
  fi
fi

echo "[go-quality] Done" >&2
exit 0
