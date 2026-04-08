#!/bin/bash
# Install Go development tools in ephemeral environments (Claude Code Web).
# In local devcontainers, tools are pre-installed via Dockerfile.

set +e  # Never exit on error in session-start

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

echo "[go-quality] Running in Claude Code Web — checking tools..." >&2

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  GOARCH="amd64" ;;
  aarch64) GOARCH="arm64" ;;
  arm64)   GOARCH="arm64" ;;
  *)
    echo "[go-quality] WARNING: unsupported architecture $ARCH — skipping tool install" >&2
    exit 0
    ;;
esac

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
  GO_ARCHIVE="go${GO_VERSION}.linux-${GOARCH}.tar.gz"
  GO_TMPDIR=$(mktemp -d)
  if curl -fsSL "https://go.dev/dl/${GO_ARCHIVE}" -o "${GO_TMPDIR}/${GO_ARCHIVE}" \
    && curl -fsSL "https://go.dev/dl/${GO_ARCHIVE}.sha256" -o "${GO_TMPDIR}/${GO_ARCHIVE}.sha256" \
    && printf "%s  %s\n" "$(cat "${GO_TMPDIR}/${GO_ARCHIVE}.sha256")" "${GO_TMPDIR}/${GO_ARCHIVE}" | sha256sum -c - >/dev/null 2>&1 \
    && tar -xzf "${GO_TMPDIR}/${GO_ARCHIVE}" -C /usr/local; then
    # Symlink so later hooks find go without PATH changes
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
    true  # installed successfully
  else
    echo "[go-quality] WARNING: golangci-lint install failed" >&2
  fi
  rm -rf "${GOLANGCI_TMPDIR}"
fi

echo "[go-quality] Done" >&2
exit 0
