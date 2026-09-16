#!/usr/bin/env bash
# Regression tests for hooks/rust-system-deps.sh — the detector that lets
# rust-test.sh and rust-clippy.sh skip (exit 0) instead of blocking (exit 2)
# when the failure is a missing system development package.
#
# Hermetic: no network, no cargo, no real repos. Every input below is a
# captured-shape cargo/pkg-config/linker transcript written to a temp file.
#
# The risk this defends against runs BOTH ways and both halves are tested:
#
#   1. A FALSE POSITIVE swallows a real failure. A type error, a failing
#      assertion, a clippy lint, or a build script that panicked on the
#      author's own bug must still block. This is the dangerous direction —
#      a swallowed failure looks exactly like a clean pass.
#   2. A FALSE NEGATIVE restores the noise the detector exists to remove.
#
# Run: bash plugins/rust-quality/tests/system-deps.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECTOR="${SCRIPT_DIR}/../hooks/rust-system-deps.sh"

if [ ! -r "$DETECTOR" ]; then
  echo "FAIL: cannot read $DETECTOR"
  exit 1
fi
# shellcheck source=/dev/null
. "$DETECTOR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

# case_is <skip|block> <expected-library-or-empty> <name>, transcript on stdin.
# Heredocs keep each transcript verbatim — no quote escaping between the real
# cargo output and what the detector sees.
case_is() {
  local want="$1" want_lib="$2" name="$3"
  local f="$TMP/out.txt" got got_lib=""
  cat > "$f"

  if rust_missing_system_dep "$f"; then
    got=skip
    got_lib="$(rust_report_missing_system_dep 'cargo test' 'crate' "$f" 2>&1 \
      | sed -n 's/.*package is missing (\([^)]*\)).*/\1/p')"
  else
    got=block
  fi

  if [ "$got" = "$want" ] && { [ "$want" != skip ] || [ "$got_lib" = "$want_lib" ]; }; then
    PASS=$((PASS + 1))
    printf 'ok   %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL %s\n     want: %s (lib %s)\n     got:  %s (lib %s)\n' \
      "$name" "$want" "${want_lib:-none}" "$got" "${got_lib:-none}"
  fi
}

# --- must SKIP: the environment is missing a system library ------------------

# The case this was written for: tv-shell's zbus -> bluer -> libdbus-sys graph
# on a hosted runner that installs no system packages.
case_is skip 'dbus-1' 'libdbus-sys via pkg-config' <<'EOF'
   Compiling libdbus-sys v0.2.5
error: failed to run custom build command for `libdbus-sys v0.2.5`

Caused by:
  process didn't exit successfully: `build-script-build` (exit status: 1)
  --- stderr
  error: could not find system library 'dbus-1' required by the 'libdbus-sys' crate
  Package dbus-1 was not found in the pkg-config search path.
  No package 'dbus-1' found
EOF

case_is skip 'openssl' 'openssl-sys, the backtick message form' <<'EOF'
error: failed to run custom build command for `openssl-sys v0.9.109`
  The system library `openssl` required by crate `openssl-sys` was not found.
  HINT: you may need to install a package such as libssl-dev.
EOF

# The linker form: the message is indented inside a rustc `= note:` block, so
# the pattern must not be anchored to the start of the line.
case_is skip 'libudev' 'linker cannot find the library' <<'EOF'
  = note: /usr/bin/ld: cannot find -ludev: No such file or directory
          collect2: error: ld returned 1 exit status
EOF

case_is skip '' 'a -sys build script missing a C header' <<'EOF'
  cargo:warning=src/wrapper.h:1:10: fatal error: dbus/dbus.h: No such file or directory
  error: failed to run custom build command for `foo-sys v0.1.0`
EOF

# --- must BLOCK: a real failure the author can fix by editing code -----------

case_is block '' 'a failing test' <<'EOF'
test foo::bar ... FAILED

failures:
    foo::bar

thread 'foo::bar' panicked at src/lib.rs:9:
assertion `left == right` failed
  left: 2
 right: 3
error: test failed, to rerun pass `--lib`
EOF

case_is block '' 'a type error' <<'EOF'
error[E0308]: mismatched types
 --> src/lib.rs:4:5
  |
4 |     "not an int"
  |     ^^^^^^^^^^^^ expected `i32`, found `&str`
EOF

case_is block '' 'a clippy lint under -D warnings' <<'EOF'
error: this `if` has identical blocks
 --> src/main.rs:7:5
error: could not compile `foo` (bin "foo") due to 1 previous error
EOF

# The exclusion that makes the detector narrow: a build script CAN fail for
# reasons that are genuinely the author's, so this message alone never skips.
case_is block '' 'a build script that panicked on its own bug' <<'EOF'
error: failed to run custom build command for `my-crate v0.1.0`

Caused by:
  process didn't exit successfully: build-script-build (exit status: 101)
  --- stderr
  thread 'main' panicked at build.rs:3:
  called `Option::unwrap()` on a `None` value
EOF

# A crate merely NAMED like a system library is not a missing system library.
case_is block '' 'a test whose name mentions a system library' <<'EOF'
test dbus::connects_to_the_system_bus ... FAILED
error: test failed, to rerun pass `--lib`
EOF

case_is block '' 'a clean run has nothing to match' <<'EOF'
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
EOF

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
