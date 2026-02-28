#!/bin/bash
# Devcontainer entrypoint — runs on every container start via postStartCommand.
#
# Keep this script idempotent (safe to run multiple times).

set -euo pipefail

echo "Entrypoint running..."

echo "Entrypoint complete."
