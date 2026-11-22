#!/usr/bin/env bash
# Full local check: clean install, type check, tests (test/dist.test.ts builds src/ and compares it with the committed dist/).
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --no-audit --no-fund
npx tsc -p tsconfig.json
node --test "test/**/*.test.ts"
