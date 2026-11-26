#!/usr/bin/env bash
# Prepare one backtest case: a clone where bt-base is the commit before a reverted Dependabot bump plus the two generic
# census journeys (a local commit), and bt-head is bt-base plus the bump. Nothing is pushed anywhere.
#
#   backtest/prepare.sh <id> <git-url> <bump-merge-commit> [<app-folder>]   (work folder: $BACKTEST_WORK or ./backtest-work)
#   bumpproof check --repo <printed clone> --base bt-base --head bt-head --dir <app-folder>
set -uo pipefail
[ $# -ge 3 ] || { sed -n '2,6p' "$0"; exit 2; }
id=$1; url=$2; M=$3; dir=${4:-.}
here=$(cd "$(dirname "$0")/.." && pwd)
work=${BACKTEST_WORK:-$PWD/backtest-work}
mkdir -p "$work"
W="$work/$id-$(date +%H%M%S)"
git clone -q --filter=blob:none --no-checkout "$url" "$W" || { echo "$id: clone failed" >&2; exit 1; }
cd "$W" || exit 1
B=$(git rev-parse "$M^1") || exit 1
P=$(git rev-parse -q --verify "$M^2" || true)
git checkout -q -b bt-base "$B" || exit 1
mkdir -p "$dir/.bumpproof/journeys"
for f in "$here"/config/census-journeys/*_test.md; do
  sed 's/{port}/4173/; s#{path}#/#' "$f" > "$dir/.bumpproof/journeys/$(basename "$f")"
done
git add -f "$dir/.bumpproof"
git -c user.name=bumpproof -c user.email=bumpproof@localhost commit -q -m "Bumpproof backtest journeys (local only)"
git checkout -q -b bt-head
if [ -n "$P" ]; then
  git -c user.name=bumpproof -c user.email=bumpproof@localhost merge -q --no-edit --no-ff "$P" || { echo "$id: merge failed" >&2; exit 1; }
else
  git -c user.name=bumpproof -c user.email=bumpproof@localhost cherry-pick "$M" > /dev/null || { echo "$id: cherry-pick failed" >&2; exit 1; }
fi
echo "$W"
