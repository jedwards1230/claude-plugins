# shellcheck shell=bash
# Missing-system-library detector, shared by rust-test.sh and rust-clippy.sh.
#
# Why: a Rust crate whose dependency graph resolves a `-sys` crate needs the
# matching system development package (libdbus-1-dev, libssl-dev, …). Where it
# is absent the build fails before a single line of the project's own code is
# compiled — in a build script, in pkg-config, or in the linker. That is an
# ENVIRONMENT gap, not a defect in the diff, and failing the Stop hook on it
# reports a problem the author cannot fix by editing code.
#
# The concrete case this was written for: the Claude PR-review reusable runs on
# a hosted runner that installs no system packages, so every Rust PR in a repo
# with such a graph drew a review comment about a missing libdbus-1-dev. The
# review job re-running cargo test is redundant with the repo's real CI anyway.
#
# Deliberately NARROW. Every pattern below is emitted by a build script,
# pkg-config, the C compiler, or the linker while looking for a system library —
# none of them can be produced by a type error, a failing assertion, or a clippy
# lint, so a real failure is never swallowed. `failed to run custom build
# command` is absent on purpose: a build script can fail for reasons that are
# genuinely the author's.
#
#   usage:  if rust_missing_system_dep "$output_file"; then … fi
rust_missing_system_dep() {
  grep -qE \
    -e "The system library \`[^\`]+\` required by crate \`[^\`]+\` was not found" \
    -e "[Cc]ould not find system library '[^']+' required by the '[^']+' crate" \
    -e "pkg-config (has not been configured|exited with status|probe failed)" \
    -e "Could not run \`(\"?PKG_CONFIG|pkg-config)" \
    -e "HINT: you may need to install a package such as" \
    -e "No package '[^']+' found" \
    -e "ld: cannot find -l[A-Za-z0-9_.+-]+" \
    -e "fatal error: [A-Za-z0-9_/.+-]+\.h: No such file or directory" \
    -- "$1" 2>/dev/null
}

# Emit the one-line explanation that replaces a failure report.
rust_report_missing_system_dep() {
  local tool="$1" crate_dir="$2" out="$3"
  local lib
  # Pull the library name out of whichever message matched, for a useful line.
  lib=$(sed -nE \
    -e "s/.*The system library \`([^\`]+)\`.*/\1/p" \
    -e "s/.*system library '([^']+)'.*/\1/p" \
    -e "s/.*No package '([^']+)' found.*/\1/p" \
    -e "s/.*ld: cannot find -l([A-Za-z0-9_.+-]+).*/lib\1/p" \
    "$out" 2>/dev/null | head -n 1)
  echo "WARNING: skipping ${tool} in crate '${crate_dir}' — a system development" >&2
  echo "         package is missing${lib:+ (${lib})}, so the build fails before any" >&2
  echo "         project code compiles. This is an environment gap, not a code" >&2
  echo "         defect; install the package and re-run to check this crate." >&2
}
