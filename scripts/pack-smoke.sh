#!/usr/bin/env bash
# Compatibility entrypoint; the check itself also runs on Windows.
set -euo pipefail
cd "$(dirname "$0")/.."
exec pnpm run pack-smoke
