#!/usr/bin/env bash
# Build and publish the demo to GitHub Pages (https://shivam30072.github.io/asvanta-demo/).
# Deploys the built site to the gh-pages branch; main keeps the source.
set -euo pipefail

cd "$(dirname "$0")/.."
WORKTREE=$(mktemp -d)

npm run build:pages
cp dist/index.html dist/404.html   # SPA fallback
touch dist/.nojekyll               # stop Jekyll eating /assets

# the local gh-pages branch is a throwaway build copy; each deploy force-pushes a fresh one
git branch -D gh-pages >/dev/null 2>&1 || true
git worktree add -q --detach "$WORKTREE"
trap 'git worktree remove -f "$WORKTREE" >/dev/null 2>&1 || true' EXIT

(
  cd "$WORKTREE"
  git checkout -q --orphan gh-pages
  git rm -rq --cached . 2>/dev/null || true
  find . -maxdepth 1 ! -name . ! -name .git -exec rm -rf {} +
  cp -r "$OLDPWD/dist/." .
  git add -A
  git commit -q -m "Deploy demo to GitHub Pages"
  git push -q -f origin gh-pages
)

echo "Deployed: https://shivam30072.github.io/asvanta-demo/"
