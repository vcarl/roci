#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=""
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then DRY_RUN=1; fi
done

echo "==> Building all packages..."
pnpm build

echo "==> Running tests..."
pnpm vitest run

echo "==> Packing tarball..."
node apps/roci/scripts/pack.js

VERSION=$(node -e "console.log(require('./apps/roci/package.json').version)")
TARBALL="roci-${VERSION}.tgz"

if [ ! -f "$TARBALL" ]; then
  echo "ERROR: Expected $TARBALL not found"
  exit 1
fi

echo "==> Packed: $TARBALL"

if [ -n "$DRY_RUN" ]; then
  echo ""
  echo "Dry run complete. To test locally:"
  echo "  mkdir ~/my-crew && cd ~/my-crew"
  echo "  npx --package $REPO_ROOT/$TARBALL roci setup kvothe --domain spacemolt"
  echo ""
  echo "To publish:"
  echo "  npm publish $REPO_ROOT/$TARBALL"
  exit 0
fi

echo "==> Publishing to npm..."
npm publish "$TARBALL"

echo "==> Tagging release..."
git tag "v$VERSION"

echo ""
echo "Published roci@$VERSION"
echo "Users can now run: npx roci setup"
