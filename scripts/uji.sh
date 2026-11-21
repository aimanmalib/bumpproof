#!/usr/bin/env bash
# Full local check: clean install, type check, build, tests. Used by CI and before every push.
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --no-audit --no-fund
npx tsc -p tsconfig.json
npx tsc -p tsconfig.build.json
node --test "test/**/*.test.ts"
