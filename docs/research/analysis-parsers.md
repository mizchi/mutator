# Evaluation of the parser / transform ecosystem for a JS/TS mutation testing tool (as of 2026-10-08)

Method: checked versions via the npm registry / crates.io API, shallow-cloned oxc and stryker-js and read the source (`~/ghq/github.com/oxc-project/oxc` sparse, `~/ghq/github.com/stryker-mutator/stryker-js`). Ran micro-benchmarks and a vitest PoC locally (Apple M3 Pro, Node v24.14.1).
Benchmark / PoC code: `scratchpad/bench/b.mjs`, `scratchpad/poc/{mutate-plugin.mjs,run.mjs,setup.ts}`.

## 0. Versions (2026-10-08)

| Target | version | Notes |
|---|---|---|
| oxc crates (`oxc`, `oxc_parser`, `oxc_ast`, `oxc_ast_visit`, `oxc_traverse`, `oxc_semantic`, `oxc_codegen`, `oxc_transformer`, `oxc_span`, `oxc_napi`) | 0.153.0 (2026-10-05) | still 0.x, a breaking minor almost every week |
| `oxc_sourcemap` | 9.0.0 | |
| npm `oxc-parser` / `oxc-transform` / `oxc-minify` / `@oxc-project/types` | 0.153.0 | napi + wasm fallback |
| `string_wizard` (crate, Rust magic-string, from rolldown) | 1.2.13 | |
| npm `magic-string` | 1.4.3 | |
| `swc_core` / `swc_ecma_parser` | 82.0.0 / 46.0.0 | npm `@swc/core` 1.16.13 |
| `@babel/parser` | 8.0.7 | |
| `tree-sitter` / `web-tree-sitter` | 0.27.0 | |
| `tree-sitter-typescript` | 0.23.2 (no updates since 2024-11) | |
| `ast-grep-core` / `@ast-grep/napi` | 0.45.3 | |
| `biome_js_parser` (crates.io) | 0.5.7 (stuck since 2024-03) | effectively usable only as a git dependency. npm `@biomejs/js-api` 6.0.0 is not a parser API |
| `vitest` / `vite` / `rolldown` | 5.0.3 / 8.3.3 / 1.2.13 | Vite 8 switched TS/JSX transforms from esbuild to Oxc |
| `@stryker-mutator/core` / `vitest-runner` / `instrumenter` | 10.0.0 | instrumenter is Babel-based |
| `@vue/compiler-sfc` / `svelte` / `@vitejs/plugin-vue` | 3.5.43 / 5.57.2 / 6.0.9 | |
| `napi` (napi-rs) | 3.14.2 | |

## 1. oxc

### 1.1 Capabilities
- **Parse TS/JSX/TSX**: yes. Switched by extension or `lang: 'js'|'jsx'|'ts'|'tsx'|'dts'` (`napi/parser/src-js/index.d.ts`). Supports Stage 3 decorators and even `import defer/source`.
- **AST + span**: on the Rust side every node has `Span { start: u32, end: u32 }` (UTF-8 byte offsets). On the npm side it is ESTree / TS-ESTree compliant with `start`/`end` (already converted to UTF-16 offsets on the JS side, so they can be passed straight to magic-string); `range` is optional.
- **Walk**:
  - Rust: `oxc_ast_visit::Visit` (read-only; easy to avoid descending into type positions by overriding `visit_ts_type` / `visit_ts_type_annotation` etc.) / `VisitMut` / `oxc_traverse` (rewrites the AST with parent references + scopes, for transformers).
  - npm: `Visitor` class (`new Visitor({ BinaryExpression(n){...}, 'X:exit'(n){...} })`), `visitorKeys` export. There is also `experimentalGetLazyVisitor()` for raw transfer lazy.
- **Telling type positions apart**: being TS-ESTree, types are dedicated nodes such as `TSTypeAnnotation`, `TSTypeReference`, `TSAsExpression`, `TSSatisfiesExpression`, `TSNonNullExpression`. Since expression nodes and type nodes are syntactically distinct, mutators can be precise with "do not enter under `TS*Type*`" and "look only at `TSAsExpression.expression`". `oxc_semantic` (Rust) has `ReferenceFlags::Type` / `Value` on symbols/references, allowing semantic checks such as whether something comes from `import type` (semantic is not available from npm; only `showSemanticErrors`).
- **Emitting edited source**:
  - (A) span-based string splicing (JS: `magic-string`, Rust: `string_wizard`). Preserves the original formatting and comments, and sourcemaps come from `generateMap({hires:'boundary'})`. Best fit for mutation instrumentation (mutant schemata = embedding all mutants as ternaries).
  - (B) `oxc_codegen`: re-emits the AST. Can output with sourcemaps, but reformats the code and requires effort to mutate the AST (`oxc_traverse` + `AstBuilder`). Unnecessary except where per-mutant diff display or "regenerate from the mutated AST" is needed.
- **TS strip**: `oxc-transform`'s `transformSync(filename, code, { sourcemap: true, typescript: {...} })`, `oxc_transformer` in Rust. There is also `isolatedDeclarationSync`. A two-stage instrument → strip needs sourcemap composition, but via Vite/Vitest, Vite chains the maps.
- **ESM info**: `result.module` has `staticImports/staticExports/dynamicImports/importMetas` (with spans). Reusable for import graph analysis (which test imports which source).

### 1.2 raw transfer
- The default `parseSync` serializes the AST to a JSON string on the Rust side → `JSON.parse` in JS.
- `experimentalRawTransfer: true` shares the Rust arena buffer with JS, and a JS-side deserializer builds objects directly (`napi/parser/src-js/raw-transfer/eager.js`). `experimentalLazy: true` deserializes only the needed nodes via getters (lazy visitor). `rawTransferSupported()` checks availability (requires 64-bit LE + a recent Node).
- Note that the option names still carry `experimental` (API change risk).

### 1.3 Measurements (M3 Pro, Node 24, mean of 5 runs)

| Operation | checker.ts (2.9MB) | App.tsx (415KB) |
|---|---|---|
| oxc `parseSync` (JSON path) | 100.3ms | 15.6ms |
| **oxc raw transfer** | **29.3ms** | **5.5ms** |
| `@babel/parser` 8 (typescript plugin) | 83.4ms | 12.9ms |
| `@swc/core` `parseSync` | 173.0ms | 25.3ms |
| `@ast-grep/napi` parse | 129.1ms | 21.6ms |
| `oxc-transform` strip TS + sourcemap | 29.9ms | 4.7ms |
| `@swc/core` transform strip TS + sourcemap | 87.0ms | 14.1ms |
| oxc Visitor + magic-string embedding BinaryExpression schemata + sourcemap | 41.3ms (2720 mutants) | 6.5ms (402 mutants) |

Observations:
- When handing the AST to JS, "JS object materialization cost" dominates over "parse speed". oxc's JSON path is slower than Babel, but raw transfer makes it about 3x faster.
- The official benchmark (https://github.com/oxc-project/bench-javascript-parser , node bindings) also shows roughly oxc ~60ms / babel ~206ms / swc ~621ms on checker.ts. Rust-native, oxc is 3x+ faster than swc (https://github.com/oxc-project/bench-javascript-parser-written-in-rust). The transformer claims 2-4x over swc and ~40x over Babel (https://oxc.rs/docs/guide/benchmarks , https://github.com/oxc-project/bench-javascript-transformer-written-in-rust). These are all the project's own benchmarks, so discount accordingly.
- **Conclusion: even for a huge 3MB file, the whole instrumentation takes ~70ms. Test execution accounts for 99%+ of total mutation testing time, so the parser can be chosen for "AST precision, maintainability, ecosystem fit (Vite 8 = Oxc)" rather than "speed".**

## 2. Alternatives

| Candidate | Pros | Cons (for this use) |
|---|---|---|
| **swc** (`swc_ecma_parser` 46 / `@swc/core` 1.16) | mature, fast in Rust, wasm plugins (example: Vitiate instruments with an SWC wasm plugin in a vite transform: https://vitiate.js.org/concepts/how-it-works/) | JS binding serializes to JSON and is slow (6x oxc raw in our measurement). Spans in the JS API are global BytePos values that accumulate across calls, awkward to handle. Own AST (non-ESTree). Frequent crate majors (swc_core 82). Drifting out of the Vite/Vitest mainstream |
| **Babel** (`@babel/parser` 8) | used by Stryker. Rich plugins/types, pure JS with no native deps, surprisingly fast (faster than oxc's JSON path) | transformation (`@babel/traverse` + generator) is slow. No path to Rust |
| **tree-sitter** + `tree-sitter-typescript` 0.23.2 | error tolerance, incremental, multi-language (community Vue/Svelte grammars exist) | CST with weak ESTree-like semantic structure. `tree-sitter-typescript` has not been updated since 2024-11, so keeping up with new syntax (late TS 5.x to 6/7, `using`, `import defer` etc.) is doubtful. No scope/semantics. Parsing is also slower than oxc |
| **ast-grep** (`@ast-grep/napi` 0.45.3 / `ast-grep-core`) | users can write mutators in YAML/patterns (`$A + $B` → `$A - $B`). Good fit for statically defined rules. `findAll` + `replace` + `commitEdits` | tree-sitter based, so it inherits the weaknesses above. Type-position detection relies on kind / `inside` rules. Better used alongside as a "DSL for user-defined mutators" than as the core engine |
| **Biome parser** (`biome_js_parser`) | lossless CST (rowan-style), strong error recovery, experimental Vue/Svelte/Astro support in v2.3-2.4 (https://biomejs.dev/blog/biome-v2-4 , https://biomejs.dev/internals/language-support) | crates.io stuck at 0.5.7 (2024-03); external use requires a git dependency. Not officially intended as a library. Parser API not available from npm. Slower than Oxc (oxc claims 5x) |

### Vue / Svelte SFC
- None of oxc / swc / Babel parse SFCs themselves. oxc also does not support template linting (https://oxc.rs/compatibility).
- Practical approach: get script block offsets via `@vue/compiler-sfc`'s `parse()` (descriptor.script / scriptSetup have `loc.start.offset`) / `svelte/compiler`'s `parse()` (start/end of the `instance` / `module` script), pass the contents to oxc with `lang`, add the block offset to the mutation spans, and apply them to a magic-string of the whole original file. Stryker does the same (`packages/instrumenter/src/parsers/html-parser.ts`, `svelte-parser.ts`, `create-parser.ts` treat `.vue` as HTML and extract the script).
- To mutate expressions inside templates (`{{ a + b }}`, `{#if x > 0}`), take expression ranges from the compiler's template AST and parse each expression with oxc via `parseSync('x.ts', '(' + expr + ')')`, a two-stage approach. Biome's SFC support is experimental and too early to depend on.
- On the Vite path, it is safest to rewrite the **raw source** of `.vue`/`.svelte` in an `enforce: 'pre'` plugin before handing it to the framework plugin (mutating the compiled render code produces large numbers of meaningless mutants).

## 3. Integration approaches

### 3.1 Current state of the Stryker (v10) vitest-runner (from reading the source)
- `packages/vitest-runner/src/vitest-test-runner.ts`: **reuses one instance per worker** via `createVitest('test', { watch:false, pool:'threads', maxWorkers:1, bail:1, coverage:false, includeTaskLocation:true, ... })`.
- **It does not use the Vite transform hook**. The instrumenter (Babel) embeds all mutants in schemata form and **copies and writes the files into a sandbox directory**, which vitest then reads normally (the `inPlace` option can overwrite the original files instead).
- Mutant switching: `ctx.provide('activeMutant', id)` → a setup file (`stryker-setup.ts`, copied into the sandbox and inserted at the head of `setupFiles`) `inject()`s it and assigns it to `globalThis.__stryker__.activeMutant`. `mutantActivation: 'static' | 'runtime'` distinguishes static mutants evaluated at module top level, which need immediate setting + reload.
- In the dry run, `beforeEach` sets `currentTestId`, and coverage counters in the instrumented code return the mutant → test mapping (perTest coverage) via `suite.meta`. Mutant runs execute only related tests via `testNamePattern` + `related`. hitLimit detects infinite loops.
- An Angular CLI issue also raises the need for "access to the Vitest instance and the provide API" (https://github.com/angular/angular-cli/issues/32182).

### 3.2 In-memory instrumentation via the Vite `transform` hook (verified with a PoC)
Built a PoC in `scratchpad/poc/` with vitest 5.0.3 + oxc-parser raw transfer + magic-string:
- Inject an `enforce:'pre'` plugin via `createVitest('test', opts, { plugins: [mutatePlugin()] })`. Parse the raw TS source of `src/**/*.ts` → replace `BinaryExpression` with `(globalThis.__mut?.active === ID ? (mutated) : (orig))`, returning a map (TS stripping is left to Vite's built-in Oxc downstream).
- Setup file: `beforeAll(() => globalThis.__mut = { active: inject('activeMutant') })`; on the node side, `vitest.provide('activeMutant', id)` → `vitest.runTestFiles([...])`.
- Result:
  ```
  active=-1 ok=true 368ms transforms=1   (first: startup + transform)
  active=0  ok=false 64ms transforms=1   (+ -> - : killed)
  active=1  ok=true 50ms transforms=1    (>= -> > : survived, correctly detects missing boundary test)
  active=-1 ok=true 47ms transforms=1
  ```
  **Only one transform**; subsequent mutant switches need only provide/inject, with no re-transform / invalidate. About 50ms per mutant (tiny case). No sandbox copy or disk writes.
- Caveats:
  - Vitest keeps Vite transform results in memory (+ `fsModuleCache` in v5). If the instrumentation strategy changes, `vitest.invalidateFile(path)` / `vitest.clearCache()` (v5+) is required (https://vitest.dev/advanced/api/vitest). With the schemata approach there is no need to change it.
  - With `isolate: true` (default), modules are re-evaluated per test file, so top-level static mutants take effect. In configurations sharing modules via `isolate:false` / `pool: 'threads'`, static mutants need a re-import (the same problem as Stryker's `static` activation).
  - Since the plugin is inserted into the user's `vitest.config` plugin list after the fact, watch the order relative to other pre plugins (vue etc.) even with `enforce:'pre'`. For `.vue`, rewrite the raw SFC before the vue plugin.
  - Vite 8 uses Oxc transform internally, so TS stripping / JSX transformation after instrumentation can be left to Vite, with no cost beyond a double parse. Vite also chains the sourcemaps.
  - Modules in node_modules / treated as `server.deps.external` do not go through transform, so they are out of scope (normally not a problem).
  - Runners other than vitest (jest, node:test, mocha) have no Vite pipeline, so this approach does not apply → a general solution needs an adapter that calls the same instrument function via "disk write (sandbox/in-place)" or "Node's module loader hook (`module.registerHooks` load hook)". Keeping instrument a pure function `(filename, code) => { code, map, mutants[] }` lets all three paths share it.

### 3.3 Comparison of options

| Option | Description | Pros | Cons |
|---|---|---|---|
| (a) Rust CLI + child process launching a Node test runner | instrument with oxc crates, write to a sandbox, spawn `vitest run` etc. | single binary distribution, fastest instrumentation, runner-agnostic | cannot reuse the Vitest instance (startup cost of hundreds of ms to seconds per mutant / batch); provide/inject and per-test coverage still need a JS-side reporter/setup; sandbox copy cost. **Tends to be the slowest** |
| (b) Rust napi addon + Node/TS orchestrator | implement instrument in oxc Rust (`oxc_parser` + `Visit` + `string_wizard` + `oxc_semantic`) exposed via napi-rs; orchestrator / vite plugin in TS | zero JS AST materialization cost (stays inside Rust), precise type/value reference checks via `oxc_semantic`, reuses vitest in-process | cross-building and distributing napi (standardized by napi-rs, but a CI burden), keeping up with oxc 0.x breaking changes, slower development iteration |
| (c) pure JS: `oxc-parser` (raw transfer) + `magic-string` | write everything in TS, use the vite plugin / vitest API directly | minimal setup, PoC done, same language and process as Vite/Vitest, npm-only distribution (oxc-parser ships prebuilt + wasm fallback), fast TDD | semantics (scope/symbol) unavailable from JS (if needed, a lightweight custom scope analysis, or move to (b) later); raw transfer is `experimental` |

## 4. Recommendation

**Start with (c), and design the contract so that only the instrument layer can later be swapped for (b).**

1. **Parser: oxc (`oxc-parser` 0.153, `experimentalRawTransfer` / lazy).** Reasons: type positions are syntactically separated in TS-ESTree; raw transfer is the fastest on the JS side (~3x vs Babel); same toolchain as Vite 8 / Rolldown / Vitest, so syntax support is unlikely to drift. swc's JS binding is slow and its spans are awkward, tree-sitter-typescript is no longer updated, and Biome is not intended for library use.
2. **Output: span splicing (`magic-string`, `string_wizard` if moved to Rust) rather than AST codegen.** Mutant schemata (embedding every mutant as `__mut.active === id ? m : orig`) preserve the original formatting and comments, and sourcemaps come for free via `generateMap`. Nested mutants (expressions within expressions) must be assembled post-order, using the string with children overwritten first as the parent's orig/mutated (naive slice replacement loses inner mutants). Do not strip TS ourselves; leave it to Vite (Oxc) or `oxc-transform`.
3. **Execution: target Vitest first, with in-memory instrumentation via the Node API (`createVitest` + `provide` + `runTestFiles`/`runTestSpecifications`) + an `enforce:'pre'` Vite plugin.** No sandbox copy, one transform, mutant switching via provide/inject only (confirmed by the PoC). The difference from Stryker = the sandbox can be dropped, and worker parallelism (multiple vitest instances or `maxWorkers` + distributing mutants to workers) can be optimized ourselves.
4. **Keep the contract layer strict**: define `instrument(file, code, opts) -> { code, map, mutants: {id, file, span, mutator, replacement}[] }` as a pure function. The Vitest plugin / Node `module.registerHooks` loader / disk-write adapters all share it. A Rust napi version would swap in under the same contract, with output-equality tests on the same fixtures.
5. **SFC**: extract script block offsets with `@vue/compiler-sfc` / `svelte/compiler` → oxc. Template expressions later.
6. If **user-defined mutators** become desirable, consider adopting ast-grep's pattern syntax as a DSL (not as the core).
7. **Criteria for moving to (b)**: profiling shows instrument exceeding a few percent of the total, or checks based on `oxc_semantic` (excluding equivalent mutants, detecting type-only imports) become essential. Given current measurements (70ms for 3MB), the need is low.

## Reference URLs
- oxc parser usage: https://oxc.rs/docs/guide/usage/parser
- oxc benchmarks: https://oxc.rs/docs/guide/benchmarks
- bench (node bindings): https://github.com/oxc-project/bench-javascript-parser
- bench (rust): https://github.com/oxc-project/bench-javascript-parser-written-in-rust
- bench transformer: https://github.com/oxc-project/bench-javascript-transformer-written-in-rust
- oxc compatibility (framework support): https://oxc.rs/compatibility
- Vitest Node API: https://vitest.dev/advanced/api/vitest
- Vite 8 migration (esbuild → Oxc): https://vite.dev/guide/migration.html
- Stryker vitest-runner source: https://github.com/stryker-mutator/stryker-js/tree/master/packages/vitest-runner/src
- Stryker instrumenter source: https://github.com/stryker-mutator/stryker-js/tree/master/packages/instrumenter/src
- Angular CLI issue (Stryker × Vitest instance): https://github.com/angular/angular-cli/issues/32182
- Vitiate (a fuzzer that instruments with SWC wasm inside a vite transform): https://vitiate.js.org/concepts/how-it-works/
- Biome v2.4 / language support: https://biomejs.dev/blog/biome-v2-4 , https://biomejs.dev/internals/language-support
- crates: https://crates.io/crates/oxc , https://crates.io/crates/string_wizard , https://crates.io/crates/swc_core , https://crates.io/crates/ast-grep-core , https://crates.io/crates/biome_js_parser
- npm: https://www.npmjs.com/package/oxc-parser , https://www.npmjs.com/package/oxc-transform , https://www.npmjs.com/package/magic-string , https://www.npmjs.com/package/@ast-grep/napi
