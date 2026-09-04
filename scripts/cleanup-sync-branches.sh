#!/usr/bin/env bash
# Clean up stale sync/upstream-* branches on the godlockin fork.
#
# A sync branch is safe to delete when its tip is fully contained in
# the fork's main (git merge-base --is-ancestor). Branches whose tip is
# not yet contained are skipped — after a sync PR merges, re-run this
# script and more branches become deletable.
#
# Usage: bash scripts/cleanup-sync-branches.sh [--dry-run]
set -euo pipefail

REMOTE="${1:-godlockin}"
DRY_RUN="${2:-}"
if [ "${REMOTE}" = "--dry-run" ]; then REMOTE="godlockin"; DRY_RUN="--dry-run"; fi

git fetch "${REMOTE}" --prune 2>/dev/null

DELETED=0
SKIPPED=0
while read -r sha ref; do
  branch="${ref#refs/heads/}"
  if git merge-base --is-ancestor "${sha}" "${REMOTE}/main" 2>/dev/null; then
    echo "DELETE  ${branch}"
    if [ -z "${DRY_RUN}" ]; then
      git push "${REMOTE}" --delete "${branch}" >/dev/null
    fi
    DELETED=$((DELETED+1))
  else
    echo "keep    ${branch} (tip not in ${REMOTE}/main)"
    SKIPPED=$((SKIPPED+1))
  fi
done < <(git ls-remote --heads "${REMOTE}" 'refs/heads/sync/*')

echo "---"
echo "deleted: ${DELETED}, kept: ${SKIPPED}${DRY_RUN:+ (dry-run)}"
