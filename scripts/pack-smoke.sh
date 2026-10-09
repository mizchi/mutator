#!/usr/bin/env bash
# Pack the publishable packages, install the tarballs into a throwaway project
# outside the workspace, and run the published CLI against a fixture.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/pack" "$work/app"
for p in core vitest typecheck cli; do (cd "$repo/packages/$p" && pnpm pack --pack-destination "$work/pack" >/dev/null); done
cp -r "$repo/packages/vitest/test/fixtures/basic/"{src,test,vitest.config.ts} "$work/app/"
cat > "$work/app/package.json" <<JSON
{
  "name": "pack-smoke",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@mizchi/mutator": "file:$work/pack/mizchi-mutator-0.0.0.tgz",
    "vitest": "5.0.3"
  }
}
JSON
cat > "$work/app/pnpm-workspace.yaml" <<YAML
packages: []
overrides:
  "@mizchi/mutator-core": "file:$work/pack/mizchi-mutator-core-0.0.0.tgz"
  "@mizchi/mutator-vitest": "file:$work/pack/mizchi-mutator-vitest-0.0.0.tgz"
  "@mizchi/mutator-typecheck": "file:$work/pack/mizchi-mutator-typecheck-0.0.0.tgz"
YAML
cd "$work/app"
pnpm install --prefer-offline >/dev/null
./node_modules/.bin/mutator -j 1 | tee "$work/out.txt"
grep -q 'age >= 18 -> age > 18' "$work/out.txt"
echo "pack-smoke: ok"
