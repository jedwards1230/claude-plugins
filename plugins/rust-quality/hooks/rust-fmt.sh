#!/bin/bash
# Auto-format Rust files after Write or Edit.
set -euo pipefail

# rustup installs cargo/rustfmt into ~/.cargo/bin, which is not on PATH in a
# fresh shell (e.g. the ephemeral Claude Code Web env that SessionStart sets
# up). Each hook runs as its own process, so prepend it here too.
export PATH="${HOME}/.cargo/bin:${PATH}"

if ! command -v jq &>/dev/null; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")

if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" ]]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
  if [[ -n "$FILE_PATH" && "$FILE_PATH" =~ \.rs$ ]]; then
    # rustfmt formats a single file in place, matching gofmt's per-file model.
    # Unlike `cargo fmt`, plain `rustfmt` does NOT infer the crate edition from
    # Cargo.toml, so 2018/2021/2024-only syntax is silently left unformatted.
    # Walk up to the nearest Cargo.toml and pass its edition explicitly
    # (default 2021 when none is found), keeping the per-file model.
    if command -v rustfmt &>/dev/null; then
      EDITION="2021"
      d=$(dirname "$FILE_PATH")
      while :; do
        if [[ -f "$d/Cargo.toml" ]]; then
          # Grab the first `edition = "YYYY"` line in the manifest.
          FOUND=$(grep -m1 -E '^[[:space:]]*edition[[:space:]]*=' "$d/Cargo.toml" 2>/dev/null \
            | sed -E 's/.*"([0-9]+)".*/\1/' || true)
          [[ -n "$FOUND" ]] && EDITION="$FOUND"
          break
        fi
        parent=$(dirname "$d")
        [[ "$parent" == "$d" ]] && break  # reached filesystem root
        d="$parent"
      done
      rustfmt --edition "$EDITION" "$FILE_PATH" 2>/dev/null || true
    fi
  fi
fi

exit 0
