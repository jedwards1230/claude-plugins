#!/bin/bash
# SessionStart hook for rust-quality.
#
# Two responsibilities:
#   1. In Claude Code Web (CLAUDE_CODE_REMOTE=true), install the Rust toolchain
#      (cargo/rustfmt/clippy), cargo-audit, and jq into the ephemeral
#      environment. Locally, tools are expected to be pre-installed.
#   2. Probe the environment regardless of remote/local and emit stdout context
#      (read by Claude as a system reminder) when the plugin's hooks would be
#      degraded — missing tools, or Rust source without a Cargo.toml.

set +e  # Never exit on error in session-start

# ---------------------------------------------------------------------------
# Install step (remote only)
# ---------------------------------------------------------------------------
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  echo "[rust-quality] Running in Claude Code Web — checking tools..." >&2

  export PATH="${HOME}/.cargo/bin:${PATH}"

  # jq is required by all hook scripts for stdin JSON parsing
  if ! command -v jq &>/dev/null; then
    echo "[rust-quality] Installing jq..." >&2
    apt-get update >/dev/null 2>&1 && apt-get install -y jq >/dev/null 2>&1 || \
      echo "[rust-quality] WARNING: jq install failed — hooks may not work" >&2
  fi

  # Rust toolchain via rustup. rustup's default profile ships rustfmt and
  # clippy, which the format and lint hooks rely on.
  if ! command -v cargo &>/dev/null; then
    echo "[rust-quality] Installing Rust toolchain via rustup..." >&2
    if curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
      && sh /tmp/rustup-init.sh -y --profile default --no-modify-path >/dev/null 2>&1; then
      export PATH="${HOME}/.cargo/bin:${PATH}"
    else
      echo "[rust-quality] WARNING: Rust install failed" >&2
    fi
    rm -f /tmp/rustup-init.sh
  fi

  # clippy / rustfmt components — ensure present even if cargo pre-existed.
  if command -v rustup &>/dev/null; then
    rustup component add clippy rustfmt >/dev/null 2>&1 || \
      echo "[rust-quality] WARNING: failed to add clippy/rustfmt components" >&2
  fi

  # cargo-audit (RUSTSEC advisory scanning) — optional but installed when remote.
  if command -v cargo &>/dev/null && ! cargo audit --version &>/dev/null; then
    echo "[rust-quality] Installing cargo-audit..." >&2
    cargo install cargo-audit --locked >/dev/null 2>&1 || \
      echo "[rust-quality] WARNING: cargo-audit install failed — audit checks will skip" >&2
  fi

  echo "[rust-quality] Install step done" >&2
fi

# ---------------------------------------------------------------------------
# Probes (always run; stdout is injected into Claude's context)
# ---------------------------------------------------------------------------

# Probe 1: missing tools, with per-tool impact messaging.
# Matches the lookup logic the hook scripts actually use.
MISSING_CARGO=true
MISSING_RUSTFMT=true
MISSING_CLIPPY=true
MISSING_AUDIT=true
MISSING_JQ=true

command -v cargo   &>/dev/null && MISSING_CARGO=false
command -v rustfmt &>/dev/null && MISSING_RUSTFMT=false
command -v jq      &>/dev/null && MISSING_JQ=false

# clippy and audit are cargo subcommands — probe them the way the hooks invoke them.
if ! $MISSING_CARGO; then
  cargo clippy --version &>/dev/null && MISSING_CLIPPY=false
  cargo audit  --version &>/dev/null && MISSING_AUDIT=false
fi

IMPACT_LINES=()
$MISSING_CARGO && IMPACT_LINES+=("  - cargo missing — test, clippy, and audit hooks all skip; no Rust quality gates run this session.")
# Suppress rustfmt/clippy/audit impact lines when cargo is also missing —
# the cargo-missing line already covers them, and printing both yields a
# contradiction.
if ! $MISSING_CARGO; then
  $MISSING_RUSTFMT && IMPACT_LINES+=("  - rustfmt missing — PostToolUse format hook no-ops; .rs edits will NOT be auto-formatted.")
  $MISSING_CLIPPY  && IMPACT_LINES+=("  - clippy missing — Stop-event lint hook skips; cargo test and cargo audit still run.")
  $MISSING_AUDIT   && IMPACT_LINES+=("  - cargo-audit missing — RUSTSEC advisory scan skips; clippy and cargo test still run.")
fi
$MISSING_JQ && IMPACT_LINES+=("  - jq missing — format hook exits early (no auto-format), and test/clippy lose their stop_hook_active loop guard.")

if [ ${#IMPACT_LINES[@]} -gt 0 ]; then
  printf '[rust-quality] Quality gates degraded — missing tools detected:\n\n'
  for line in "${IMPACT_LINES[@]}"; do
    printf '%s\n' "$line"
  done
  cat <<EOF

Install:
  rust (cargo/rustfmt/clippy): https://rustup.rs/  (then \`rustup component add clippy rustfmt\`)
  cargo-audit:                 \`cargo install cargo-audit --locked\`
  jq:                          \`brew install jq\` / \`apt-get install jq\`

Please alert the user about the missing tools so they can install them or
move to an environment that has them — not all chat clients surface hook
output, so a human-readable mention in your next reply is the only way
they'll know.
EOF
fi

# Probe 2: detect repos where the toolchain won't work cleanly.
#
# The Stop hooks dispatch per-crate: they walk up from each modified .rs
# file to its owning Cargo.toml and run test/clippy/audit from that
# directory. So the probe only needs to flag the case where tracked Rust
# source exists but NO Cargo.toml is reachable anywhere — that's the only
# state where the hooks have nothing to dispatch against.
#
# Workspace mode (root Cargo.toml with [workspace]) and single-crate mode
# (root Cargo.toml) both work cleanly from the root, so stay silent.
# Multi-crate repos with nested Cargo.toml files also work via per-crate
# dispatch — emit an info message so the assistant knows the gates are active.
#
# We use \`git ls-files\` instead of \`find\` so the probe naturally respects
# .gitignore and nested git boundaries: independently cloned repos under
# this tree (with their own .git dirs) are excluded by git's worktree
# semantics, so we don't false-fire on ops repos that vendor unrelated Rust
# projects.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT" ]; then
  # Skip silently if root has a Cargo.toml — toolchain runs from root.
  if [ ! -f "$REPO_ROOT/Cargo.toml" ]; then
    TRACKED_RS=$(cd "$REPO_ROOT" && git ls-files -- '*.rs' 2>/dev/null | head -n 1)
    if [ -n "$TRACKED_RS" ]; then
      # Tracked Rust but no root Cargo.toml. Look for nested Cargo.toml files.
      NESTED_CRATES=$(cd "$REPO_ROOT" && git ls-files 2>/dev/null | grep '/Cargo\.toml$' || true)
      if [ -z "$NESTED_CRATES" ]; then
        # No crates anywhere — real problem
        cat <<EOF
[rust-quality] Tracked Rust source files but no Cargo.toml anywhere in the repo.

The plugin's Stop hooks need a crate to run \`cargo test\` / \`cargo clippy\` /
\`cargo audit\` against. Either init a crate:

  cargo init

…or add a workspace (\`[workspace]\` in the root Cargo.toml) if you have
multiple crates.

Please alert the user — not all chat clients surface hook output.
EOF
      else
        # Multi-crate repo — gates dispatch per-crate, friendly info only.
        nested_count=$(printf '%s\n' "$NESTED_CRATES" | wc -l | tr -d ' ')
        echo "[rust-quality] Multi-crate repo detected — $nested_count nested Cargo.toml file(s):"
        printf '%s\n' "$NESTED_CRATES" | head -10 | sed 's|^|  - |'
        if [ "$nested_count" -gt 10 ]; then
          echo "  ... ($((nested_count - 10)) more)"
        fi
        echo ""
        echo "Stop hooks will dispatch test/clippy/audit per-crate on the crate owning each modified file. No action needed."
      fi
    fi
    # else: no tracked Rust at all — plugin is dormant here, silent.
  fi
  # else: root has Cargo.toml — toolchain works from root, silent.
fi

exit 0
