#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tools/untrack_offline_cache_dbs.sh [--apply]

Removes project/cache/offline_weather*.sqlite files from the git index while
keeping the local files on disk.

Without --apply, prints the files that would be untracked.
With --apply, runs git rm --cached on the tracked offline cache DBs.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

apply=0
if [[ "${1:-}" == "--apply" ]]; then
  apply=1
elif [[ $# -gt 0 ]]; then
  usage >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

tracked_files=()
while IFS= read -r file_path; do
  tracked_files+=("$file_path")
done < <(git ls-files -- 'project/cache/offline_weather*.sqlite')

if [[ ${#tracked_files[@]} -eq 0 ]]; then
  echo "No tracked offline cache DBs found in the git index."
  exit 0
fi

printf 'Tracked offline cache DBs in git index:\n'
printf '  %s\n' "${tracked_files[@]}"

if [[ $apply -eq 0 ]]; then
  echo
  echo "Dry run only. Re-run with --apply to untrack these files while keeping them locally."
  exit 0
fi

git rm --cached -- "${tracked_files[@]}"

echo
echo "Removed the files above from the git index only."
echo "Next steps:"
echo "  git commit -m 'Stop tracking generated offline cache DBs'"
echo "  git lfs prune"
