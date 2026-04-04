#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${1:-}"
DRY_RUN="${2:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/release.sh <version> [--dry-run]"
  echo ""
  echo "Examples:"
  echo "  ./scripts/release.sh 0.1.0           # publish to npm"
  echo "  ./scripts/release.sh 0.1.0 --dry-run # build + pack only, no publish"
  echo ""
  echo "For local testing after --dry-run:"
  echo "  npx ./roci-<version>.tgz setup kvothe --domain spacemolt"
  exit 1
fi

echo "==> Building all packages..."
pnpm build

echo "==> Running tests..."
pnpm vitest run

echo "==> Setting version to $VERSION..."
cd apps/roci
npm version "$VERSION" --no-git-tag-version
cd "$REPO_ROOT"

echo "==> Packing tarball..."
node apps/roci/scripts/pack.js

TARBALL="roci-${VERSION}.tgz"
if [ ! -f "$TARBALL" ]; then
  echo "ERROR: Expected $TARBALL not found"
  exit 1
fi

echo "==> Packed: $TARBALL"

if [ "$DRY_RUN" = "--dry-run" ]; then
  echo ""
  echo "Dry run complete. To test locally:"
  echo "  mkdir ~/my-crew && cd ~/my-crew"
  echo "  npx --package $REPO_ROOT/$TARBALL roci setup kvothe --domain spacemolt"
  echo ""
  echo "To publish for real:"
  echo "  npm publish $REPO_ROOT/$TARBALL"
  exit 0
fi

echo "==> Publishing to npm..."
npm publish "$TARBALL"

echo "==> Tagging release..."
git add apps/roci/package.json
git commit -m "release: v$VERSION"
git tag "v$VERSION"

echo ""
echo "Published roci@$VERSION"
echo "Users can now run: npx roci setup"
