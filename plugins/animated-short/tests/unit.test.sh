#!/usr/bin/env bash
# Unit tests for the animated-short Python tools (skills/animated-short/scripts).
#
# Hermetic: every provider call goes to a fake OpenRouter server on 127.0.0.1 (scripts/tests/helpers.py
# points OPENROUTER_BASE_URL there and sets a fake key), films are built in temp directories, and
# nothing costs money. Tests that need numpy, pillow, node or ffmpeg skip themselves when those are
# missing. The golden end-to-end run (scripts/test-golden.sh) is not part of this suite: it needs npm
# and Chromium.
#
# Run: bash plugins/animated-short/tests/unit.test.sh   (PYTHON=<interpreter> to pick another Python)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS="${SCRIPT_DIR}/../skills/animated-short/scripts/tests"
PY="${PYTHON:-python3}"

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "FAIL: $PY not found (the tools need Python 3.10+)"
  exit 1
fi
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "FAIL: $("$PY" --version 2>&1) is older than 3.10"
  exit 1
fi
if [ ! -d "$TESTS" ]; then
  echo "FAIL: no test directory at $TESTS"
  exit 1
fi

# no real key, account ceiling or bytecode leaks into or out of the run
unset OPENROUTER_API_KEY OPENROUTER_BASE_URL ANIMATED_SHORT_ACCOUNT_CEILING ANIMATED_SHORT_REGISTRY
export PYTHONDONTWRITEBYTECODE=1 NO_COLOR=1

"$PY" -m unittest discover -s "$TESTS"
status=$?
if [ "$status" -eq 0 ]; then
  echo "PASS: animated-short unit tests"
else
  echo "FAIL: animated-short unit tests (exit $status)"
fi
exit "$status"
