#!/usr/bin/env bash
# Prints gh-monitor's "What it looks like" capture: every status, band, toast
# and deploy-prompt string from the real render code, with widths, and a
# terminal mock (tests/ui-capture.test.ts). Pass a path to also write it there.
#   plugins/gh-monitor/tests/capture.sh [out.txt]
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)"
capture="$(claude plugin test "$dir" 2>&1 | sed -n '/^=====CAPTURE BEGIN$/,/^=====CAPTURE END$/p' | sed '1d;$d')"
if [ -z "$capture" ]; then
  echo "capture.sh: no capture in the test output (did ui-capture.test.ts fail?)" >&2
  exit 1
fi
if [ $# -gt 0 ]; then printf '%s\n' "$capture" > "$1"; fi
printf '%s\n' "$capture"
