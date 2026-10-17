#!/usr/bin/env bash
# Pack the publishable packages, install the tarballs into a throwaway project
# outside the workspace, and run the published CLI against a fixture.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/pack" "$work/app"
# The packages are versioned in lockstep.
version=$(node -p "require('$repo/packages/cli/package.json').version")
for p in core vitest jest playwright typecheck cli; do (cd "$repo/packages/$p" && pnpm pack --pack-destination "$work/pack" >/dev/null); done
cp -r "$repo/packages/vitest/test/fixtures/basic/"{src,test,vitest.config.ts} "$work/app/"
cat > "$work/app/package.json" <<JSON
{
  "name": "pack-smoke",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@mizchi/mutator": "file:$work/pack/mizchi-mutator-$version.tgz",
    "vitest": "5.0.3"
  }
}
JSON
cat > "$work/app/pnpm-workspace.yaml" <<YAML
packages: []
overrides:
  "@mizchi/mutator-core": "file:$work/pack/mizchi-mutator-core-$version.tgz"
  "@mizchi/mutator-vitest": "file:$work/pack/mizchi-mutator-vitest-$version.tgz"
  "@mizchi/mutator-typecheck": "file:$work/pack/mizchi-mutator-typecheck-$version.tgz"
  "@mizchi/mutator-jest": "file:$work/pack/mizchi-mutator-jest-$version.tgz"
  "@mizchi/mutator-playwright": "file:$work/pack/mizchi-mutator-playwright-$version.tgz"
YAML
cd "$work/app"
pnpm install --prefer-offline >/dev/null
./node_modules/.bin/mutator -j 1 | tee "$work/out.txt"
grep -q 'age >= 18 -> age > 18' "$work/out.txt"

# The agent skill ships in the CLI tarball and init-skill installs it.
# grep without -q reads the whole listing: an early exit would fail tar with SIGPIPE under pipefail.
tar -tzf "$work/pack/mizchi-mutator-$version.tgz" | grep -x 'package/skills/mutation-test-loop/SKILL.md' >/dev/null
./node_modules/.bin/mutator init-skill
cmp -s .claude/skills/mutation-test-loop/SKILL.md "$repo/packages/cli/skills/mutation-test-loop/SKILL.md"
./node_modules/.bin/mutator init-skill | grep -q 'is up to date'

# Jest (native ESM) project
mkdir -p "$work/jest-app"
cp -r "$repo/packages/jest/test/fixtures/esm/"{src,__tests__,jest.config.js} "$work/jest-app/"
cat > "$work/jest-app/package.json" <<JSON
{
  "name": "pack-smoke-jest",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@mizchi/mutator": "file:$work/pack/mizchi-mutator-$version.tgz",
    "jest": "30.5.2"
  }
}
JSON
cp "$work/app/pnpm-workspace.yaml" "$work/jest-app/"
printf 'allowBuilds:\n  "@parcel/watcher": false\n  unrs-resolver: false\n' >> "$work/jest-app/pnpm-workspace.yaml"
cd "$work/jest-app"
pnpm install --prefer-offline >/dev/null
./node_modules/.bin/mutator -j 2 | tee "$work/jest-out.txt"
grep -q 'age >= 18 -> age > 18' "$work/jest-out.txt"

# Playwright (E2E through a Vite dev server): the fixture, the Vite plugin and the session from the tarballs
mkdir -p "$work/pw-app"
cp -r "$repo/packages/playwright/test/fixtures/app/"{src,tests,index.html,other.html,vite.config.ts,playwright.config.ts} "$work/pw-app/"
pw=$(node -p "require('$repo/packages/playwright/package.json').devDependencies['@playwright/test']")
vite=$(node -p "require('$repo/packages/playwright/package.json').devDependencies.vite")
cat > "$work/pw-app/package.json" <<JSON
{
  "name": "pack-smoke-playwright",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@mizchi/mutator": "file:$work/pack/mizchi-mutator-$version.tgz",
    "@mizchi/mutator-playwright": "file:$work/pack/mizchi-mutator-playwright-$version.tgz",
    "@playwright/test": "$pw",
    "vite": "$vite"
  }
}
JSON
cp "$work/jest-app/pnpm-workspace.yaml" "$work/pw-app/"
cd "$work/pw-app"
pnpm install --prefer-offline >/dev/null
MUTATOR_TEST_PORT=5391 ./node_modules/.bin/mutator --runner playwright -j 2 | tee "$work/pw-out.txt"
grep -q 'n >= 10 -> n > 10' "$work/pw-out.txt"
echo "pack-smoke: ok"
