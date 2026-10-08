# JS/TS mutation testing tool 向け parser / transform エコシステム評価 (2026-10-08 時点)

調査方法: npm registry / crates.io API でバージョン確認、oxc と stryker-js を shallow clone して source を読んだ (`~/ghq/github.com/oxc-project/oxc` sparse, `~/ghq/github.com/stryker-mutator/stryker-js`)。手元でマイクロベンチと vitest PoC を実行 (Apple M3 Pro, Node v24.14.1)。
ベンチ / PoC のコード: `scratchpad/bench/b.mjs`, `scratchpad/poc/{mutate-plugin.mjs,run.mjs,setup.ts}`。

## 0. バージョン一覧 (2026-10-08)

| 対象 | version | 備考 |
|---|---|---|
| oxc crates (`oxc`, `oxc_parser`, `oxc_ast`, `oxc_ast_visit`, `oxc_traverse`, `oxc_semantic`, `oxc_codegen`, `oxc_transformer`, `oxc_span`, `oxc_napi`) | 0.153.0 (2026-10-05) | まだ 0.x、ほぼ毎週 minor で breaking あり |
| `oxc_sourcemap` | 9.0.0 | |
| npm `oxc-parser` / `oxc-transform` / `oxc-minify` / `@oxc-project/types` | 0.153.0 | napi + wasm fallback |
| `string_wizard` (crate, Rust 版 magic-string, rolldown 由来) | 1.2.13 | |
| npm `magic-string` | 1.4.3 | |
| `swc_core` / `swc_ecma_parser` | 82.0.0 / 46.0.0 | npm `@swc/core` 1.16.13 |
| `@babel/parser` | 8.0.7 | |
| `tree-sitter` / `web-tree-sitter` | 0.27.0 | |
| `tree-sitter-typescript` | 0.23.2 (2024-11 から更新なし) | |
| `ast-grep-core` / `@ast-grep/napi` | 0.45.3 | |
| `biome_js_parser` (crates.io) | 0.5.7 (2024-03 で止まっている) | 実質 git 依存でしか使えない。npm `@biomejs/js-api` 6.0.0 は parser API ではない |
| `vitest` / `vite` / `rolldown` | 5.0.3 / 8.3.3 / 1.2.13 | Vite 8 は TS/JSX 変換が esbuild → Oxc |
| `@stryker-mutator/core` / `vitest-runner` / `instrumenter` | 10.0.0 | instrumenter は Babel ベース |
| `@vue/compiler-sfc` / `svelte` / `@vitejs/plugin-vue` | 3.5.43 / 5.57.2 / 6.0.9 | |
| `napi` (napi-rs) | 3.14.2 | |

## 1. oxc

### 1.1 できること
- **Parse TS/JSX/TSX**: 可能。拡張子 or `lang: 'js'|'jsx'|'ts'|'tsx'|'dts'` で切替 (`napi/parser/src-js/index.d.ts`)。Stage 3 decorators, `import defer/source` まで対応。
- **AST + span**: Rust 側は全ノードが `Span { start: u32, end: u32 }` (UTF-8 byte offset)。npm 側は ESTree / TS-ESTree 準拠で `start`/`end` (JS 側は UTF-16 offset に変換済み。magic-string にそのまま渡せる)、`range` は option。
- **Walk**:
  - Rust: `oxc_ast_visit::Visit` (read-only, `visit_ts_type` / `visit_ts_type_annotation` 等を override して型位置に降りない制御が容易) / `VisitMut` / `oxc_traverse` (親参照 + scope 付きで AST を書き換える、transformer 用)。
  - npm: `Visitor` class (`new Visitor({ BinaryExpression(n){...}, 'X:exit'(n){...} })`)、`visitorKeys` export。raw transfer lazy 用の `experimentalGetLazyVisitor()` もある。
- **型位置の判別**: TS-ESTree なので型は `TSTypeAnnotation`, `TSTypeReference`, `TSAsExpression`, `TSSatisfiesExpression`, `TSNonNullExpression` 等の専用ノード。式ノードと型ノードが構文上区別されるので、mutator は「`TS*Type*` 配下に入らない」「`TSAsExpression.expression` だけ見る」で精度よく扱える。`oxc_semantic` (Rust) なら symbol/reference に `ReferenceFlags::Type` / `Value` があり、`import type` 由来か等の semantic 判定も可能 (npm 側からは semantic は使えない。`showSemanticErrors` だけ)。
- **編集済みソースの出力**:
  - (A) span ベースの文字列 splice (JS: `magic-string`, Rust: `string_wizard`)。元のフォーマット・コメントを保ち、sourcemap も `generateMap({hires:'boundary'})` で出る。mutation instrumentation (mutant schemata = 全 mutant を三項演算子で埋め込む) にはこれが最適。
  - (B) `oxc_codegen`: AST を再出力。sourcemap 付き出力可能だが再フォーマットされ、AST を mutate する手間 (`oxc_traverse` + `AstBuilder`) がかかる。mutant 単体の差分表示や「mutated AST から再生成」が必要な場面以外は不要。
- **TS strip**: `oxc-transform` の `transformSync(filename, code, { sourcemap: true, typescript: {...} })`、Rust は `oxc_transformer`。`isolatedDeclarationSync` もある。instrument → strip の 2 段にすると sourcemap の合成が要るが、Vite/Vitest 経由なら Vite が map を chain してくれる。
- **ESM 情報**: `result.module` に `staticImports/staticExports/dynamicImports/importMetas` (span 付き)。import graph 解析 (どの test がどの source を import するか) に再利用可能。

### 1.2 raw transfer
- 既定の `parseSync` は Rust 側で AST を JSON 文字列化 → JS で `JSON.parse`。
- `experimentalRawTransfer: true` は Rust arena のバッファを JS と共有し、JS 側 deserializer が直接オブジェクト化する (`napi/parser/src-js/raw-transfer/eager.js`)。`experimentalLazy: true` は必要なノードだけ getter で deserialize (lazy visitor)。`rawTransferSupported()` で可否判定 (64bit LE + 新しめの Node が条件)。
- オプション名に `experimental` が残っている点は注意 (API 変更リスク)。

### 1.3 実測 (M3 Pro, Node 24, 5 回平均)

| 処理 | checker.ts (2.9MB) | App.tsx (415KB) |
|---|---|---|
| oxc `parseSync` (JSON 経路) | 100.3ms | 15.6ms |
| **oxc raw transfer** | **29.3ms** | **5.5ms** |
| `@babel/parser` 8 (typescript plugin) | 83.4ms | 12.9ms |
| `@swc/core` `parseSync` | 173.0ms | 25.3ms |
| `@ast-grep/napi` parse | 129.1ms | 21.6ms |
| `oxc-transform` strip TS + sourcemap | 29.9ms | 4.7ms |
| `@swc/core` transform strip TS + sourcemap | 87.0ms | 14.1ms |
| oxc Visitor + magic-string で BinaryExpression schemata 埋め込み + sourcemap | 41.3ms (2720 mutants) | 6.5ms (402 mutants) |

観察:
- JS へ AST を渡す経路では「parse 速度」より「JS オブジェクト化コスト」が支配的。oxc の JSON 経路は Babel より遅いが、raw transfer で約 3x 速くなる。
- 公式ベンチ (https://github.com/oxc-project/bench-javascript-parser , node bindings) でも checker.ts で oxc ~60ms / babel ~206ms / swc ~621ms 程度。Rust-native では oxc は swc 比 3x 以上 (https://github.com/oxc-project/bench-javascript-parser-written-in-rust)。transformer は swc 比 2〜4x、Babel 比 ~40x を主張 (https://oxc.rs/docs/guide/benchmarks , https://github.com/oxc-project/bench-javascript-transformer-written-in-rust)。いずれもプロジェクト自身のベンチなので割り引くこと。
- **結論: 3MB の巨大ファイルでも instrument 全体で ~70ms。mutation testing の総時間はテスト実行が 99% 以上を占めるので、parser 選定は「速度」より「AST 精度・保守性・エコシステム整合 (Vite 8 = Oxc)」で決めてよい。**

## 2. 代替候補

| 候補 | Pros | Cons (この用途) |
|---|---|---|
| **swc** (`swc_ecma_parser` 46 / `@swc/core` 1.16) | 成熟、Rust で高速、wasm plugin (Vitiate が vite transform で SWC wasm plugin を使って instrument している例: https://vitiate.js.org/concepts/how-it-works/) | JS binding は JSON serialize で遅い (実測 oxc raw の 6x)。JS API の span は呼び出し毎に累積する global BytePos で扱いづらい。独自 AST (非 ESTree)。crate の major が頻繁 (swc_core 82)。Vite/Vitest エコシステムの主流から外れつつある |
| **Babel** (`@babel/parser` 8) | Stryker が使用。プラグイン/型が豊富、純 JS で native 依存なし、意外に速い (oxc JSON 経路より速い) | 変換 (`@babel/traverse` + generator) は遅い。Rust 化の道がない |
| **tree-sitter** + `tree-sitter-typescript` 0.23.2 | エラー耐性、incremental、多言語 (Vue/Svelte grammar も community にある) | CST で ESTree 的な意味構造が弱い。`tree-sitter-typescript` が 2024-11 から更新停止で新構文 (TS 5.x 後半〜6/7、`using`, `import defer` 等) の追随が不安。scope/semantic なし。parse も oxc より遅い |
| **ast-grep** (`@ast-grep/napi` 0.45.3 / `ast-grep-core`) | YAML/pattern でユーザー定義 mutator を書ける (`$A + $B` → `$A - $B`)。rule の静的定義と相性が良い。`findAll` + `replace` + `commitEdits` | tree-sitter ベースなので上記の弱点をそのまま継承。型位置判定は kind / `inside` ルール頼み。core engine にするより「ユーザー拡張 mutator 用 DSL」として併用が筋 |
| **Biome parser** (`biome_js_parser`) | lossless CST (rowan 系)、エラー回復が強い、v2.3〜2.4 で Vue/Svelte/Astro を experimental 対応 (https://biomejs.dev/blog/biome-v2-4 , https://biomejs.dev/internals/language-support) | crates.io は 0.5.7 (2024-03) で止まり、外部利用は git 依存。公式に library 提供を想定していない。npm から parser API を使えない。Oxc より遅い (oxc は 5x と主張) |

### Vue / Svelte SFC
- oxc / swc / Babel いずれも SFC 自体は parse しない。oxc も template linting 非対応 (https://oxc.rs/compatibility)。
- 現実解: `@vue/compiler-sfc` の `parse()` (descriptor.script / scriptSetup に `loc.start.offset` あり) / `svelte/compiler` の `parse()` (`instance` / `module` script の start/end) で script block の offset を取り、その中身を oxc に `lang` 指定で渡し、mutation の span に block offset を足して元ファイル全体の magic-string に適用。Stryker も同方式 (`packages/instrumenter/src/parsers/html-parser.ts`, `svelte-parser.ts`, `create-parser.ts` で `.vue` を HTML として扱い script を抽出)。
- template 内の式 (`{{ a + b }}`, `{#if x > 0}`) を mutate したい場合は、compiler の template AST から式範囲を取り、式単位で oxc に `parseSync('x.ts', '(' + expr + ')')` する二段構え。Biome の SFC 対応は experimental で依存するには早い。
- Vite 経路なら `enforce: 'pre'` plugin で `.vue`/`.svelte` の **生ソース** を書き換えてから framework plugin に渡すのが安全 (コンパイル後の render code を mutate すると無意味な mutant が大量発生する)。

## 3. 統合アプローチ

### 3.1 Stryker (v10) vitest-runner の現状 (source 読み)
- `packages/vitest-runner/src/vitest-test-runner.ts`: `createVitest('test', { watch:false, pool:'threads', maxWorkers:1, bail:1, coverage:false, includeTaskLocation:true, ... })` を **1 worker 1 instance で使い回す**。
- **Vite transform hook は使っていない**。instrumenter (Babel) が全 mutant を schemata 形式で埋め込んだファイルを **sandbox ディレクトリにコピーして書き出し**、vitest はそれを普通に読む (`inPlace` オプションで元ファイル上書きも可)。
- mutant 切替は `ctx.provide('activeMutant', id)` → setup file (`stryker-setup.ts`, sandbox に copy されて `setupFiles` 先頭に挿入) で `inject()` して `globalThis.__stryker__.activeMutant` に代入。`mutantActivation: 'static' | 'runtime'` で、module top-level で評価される static mutant は即時設定 + reload が必要という区別。
- dry-run では `beforeEach` で `currentTestId` を設定し、instrument コード側の coverage counter が mutant → test の対応 (perTest coverage) を `suite.meta` 経由で返す。mutant run は `testNamePattern` + `related` で関係テストだけ流す。hitLimit で無限ループ検出。
- Angular CLI 側の issue でも「Vitest instance への access と provide API が必要」という要求が出ている (https://github.com/angular/angular-cli/issues/32182)。

### 3.2 Vite `transform` hook による in-memory instrumentation (PoC で検証済み)
`scratchpad/poc/` で vitest 5.0.3 + oxc-parser raw transfer + magic-string の PoC を作成:
- `createVitest('test', opts, { plugins: [mutatePlugin()] })` で `enforce:'pre'` の plugin を注入。`src/**/*.ts` の TS 生ソースを parse → `BinaryExpression` を `(globalThis.__mut?.active === ID ? (mutated) : (orig))` に置換、map 付きで返す (TS strip は後段の Vite 内蔵 Oxc に任せる)。
- setup file で `beforeAll(() => globalThis.__mut = { active: inject('activeMutant') })`、node 側は `vitest.provide('activeMutant', id)` → `vitest.runTestFiles([...])`。
- 結果:
  ```
  active=-1 ok=true 368ms transforms=1   (初回: 起動 + transform)
  active=0  ok=false 64ms transforms=1   (+ -> - : killed)
  active=1  ok=true 50ms transforms=1    (>= -> > : survived, 境界値テスト欠如を正しく検出)
  active=-1 ok=true 47ms transforms=1
  ```
  **transform は 1 回だけ**、以降の mutant 切替は provide/inject のみで再 transform / invalidate 不要。1 mutant 50ms 程度 (極小ケース)。sandbox copy も disk 書き込みも不要。
- 注意点:
  - Vitest は Vite の transform 結果を in-memory (+ v5 では `fsModuleCache`) に保持する。instrument 方針を変えたら `vitest.invalidateFile(path)` / `vitest.clearCache()` (v5+) が必要 (https://vitest.dev/advanced/api/vitest)。schemata 方式なら変える必要がない。
  - `isolate: true` (default) ならテストファイルごとに module が再評価されるので top-level の static mutant も効く。`isolate:false` / `pool: 'threads'` で module を共有する構成では static mutant は再 import が必要 (Stryker の `static` activation と同じ問題)。
  - user の `vitest.config` の plugin 列に後から差し込むので、`enforce:'pre'` でも他の pre plugin (vue 等) との順序に注意。`.vue` は vue plugin より前で生 SFC を書き換える。
  - Vite 8 は内部で Oxc transform を使うため、instrument 後の TS strip / JSX 変換は Vite に任せられ、二重 parse 以外のコストはない。sourcemap も Vite が chain する。
  - node_modules / `server.deps.external` 扱いの module は transform を通らないので対象外 (通常問題なし)。
  - vitest 以外 (jest, node:test, mocha) は Vite pipeline がないので、この方式は使えない → 汎用には「disk 書き出し (sandbox/in-place)」か「Node の module loader hook (`module.registerHooks` の load hook)」で同じ instrument 関数を呼ぶ adapter が必要。instrument 関数は `(filename, code) => { code, map, mutants[] }` の純関数にしておけば 3 経路で共有できる。

### 3.3 選択肢比較

| 案 | 内容 | Pros | Cons |
|---|---|---|---|
| (a) Rust CLI + child process で Node test runner を起動 | oxc crates で instrument、sandbox に書き出し、`vitest run` 等を spawn | 単一 binary 配布、instrument 最速、runner 非依存 | Vitest instance を使い回せない (mutant ごと / バッチごとに起動コスト数百 ms〜秒)、provide/inject や per-test coverage の取得に結局 JS 側 reporter/setup が必要、sandbox copy コスト。**最も遅くなりがち** |
| (b) Rust napi addon + Node/TS orchestrator | instrument を oxc Rust (`oxc_parser` + `Visit` + `string_wizard` + `oxc_semantic`) で実装し napi-rs で公開、orchestrator / vite plugin は TS | JS AST 化コストゼロ (Rust 内で完結)、`oxc_semantic` で型/値参照の精密判定、in-process で vitest 再利用 | napi のクロスビルド・配布 (napi-rs で定型化されているが CI 負担)、oxc 0.x の breaking 追随、開発 iteration が遅い |
| (c) pure JS: `oxc-parser` (raw transfer) + `magic-string` | すべて TS で書き、vite plugin / vitest API を直接使う | 最小構成で PoC 済み、Vite/Vitest と同じ言語・同じ process、配布が npm だけ (oxc-parser は prebuilt + wasm fallback)、TDD が速い | semantic (scope/symbol) が JS からは使えない (必要なら軽量な自前 scope 解析 or 後から (b) へ)、raw transfer が `experimental` |

## 4. 推奨

**(c) から始めて、instrument 層だけ将来 (b) に差し替え可能な契約で設計する。**

1. **Parser: oxc (`oxc-parser` 0.153, `experimentalRawTransfer` / lazy)。** 理由: TS-ESTree で型位置が構文的に分離、raw transfer で JS 側最速 (Babel 比 ~3x)、Vite 8 / Rolldown / Vitest と同じ toolchain なので構文サポートのズレが起きにくい。swc は JS binding が遅く span が扱いにくい、tree-sitter-typescript は更新停止、Biome は library 利用を想定していない。
2. **出力: AST codegen ではなく span splice (`magic-string`、Rust 化時は `string_wizard`)。** mutant schemata (全 mutant を `__mut.active === id ? m : orig` で埋め込む) で元フォーマット・コメント保持、sourcemap は `generateMap` で無料。ネストした mutant (式の中の式) は「子から順に overwrite した文字列を親の orig/mutated に使う」post-order で組み立てる必要がある (単純な slice 置換は内側 mutant を失う)。TS strip は自前でやらず Vite (Oxc) or `oxc-transform` に任せる。
3. **実行: Vitest を第一 target とし、Node API (`createVitest` + `provide` + `runTestFiles`/`runTestSpecifications`) + `enforce:'pre'` の Vite plugin で in-memory instrumentation。** sandbox copy 不要、transform 1 回、mutant 切替は provide/inject のみ (PoC で確認)。Stryker の差分 = sandbox を捨てられる点と、worker 並列 (複数 vitest instance or `maxWorkers` + mutant を worker に割り振る) を自前で最適化できる点。
4. **契約層を厳密に**: `instrument(file, code, opts) -> { code, map, mutants: {id, file, span, mutator, replacement}[] }` を純関数として定義。Vitest plugin / Node `module.registerHooks` loader / disk 書き出しの 3 adapter がこれを共有。Rust napi 版を作っても同じ契約で差し替え、同一 fixture で出力一致テスト。
5. **SFC**: `@vue/compiler-sfc` / `svelte/compiler` で script block offset を抽出 → oxc。template 式は後回し。
6. **ユーザー定義 mutator** が欲しくなったら ast-grep の pattern 構文を DSL として採用検討 (core にはしない)。
7. **(b) に移る判断基準**: profile で instrument が全体の数 % を超える、または `oxc_semantic` 由来の判定 (equivalent mutant 除外、型専用 import 判定) が必須になったとき。現状の実測 (3MB で 70ms) では必要性は低い。

## 参考 URL
- oxc parser usage: https://oxc.rs/docs/guide/usage/parser
- oxc benchmarks: https://oxc.rs/docs/guide/benchmarks
- bench (node bindings): https://github.com/oxc-project/bench-javascript-parser
- bench (rust): https://github.com/oxc-project/bench-javascript-parser-written-in-rust
- bench transformer: https://github.com/oxc-project/bench-javascript-transformer-written-in-rust
- oxc compatibility (framework 対応): https://oxc.rs/compatibility
- Vitest Node API: https://vitest.dev/advanced/api/vitest
- Vite 8 migration (esbuild → Oxc): https://vite.dev/guide/migration.html
- Stryker vitest-runner source: https://github.com/stryker-mutator/stryker-js/tree/master/packages/vitest-runner/src
- Stryker instrumenter source: https://github.com/stryker-mutator/stryker-js/tree/master/packages/instrumenter/src
- Angular CLI issue (Stryker × Vitest instance): https://github.com/angular/angular-cli/issues/32182
- Vitiate (vite transform 内で SWC wasm instrument する fuzzer): https://vitiate.js.org/concepts/how-it-works/
- Biome v2.4 / language support: https://biomejs.dev/blog/biome-v2-4 , https://biomejs.dev/internals/language-support
- crates: https://crates.io/crates/oxc , https://crates.io/crates/string_wizard , https://crates.io/crates/swc_core , https://crates.io/crates/ast-grep-core , https://crates.io/crates/biome_js_parser
- npm: https://www.npmjs.com/package/oxc-parser , https://www.npmjs.com/package/oxc-transform , https://www.npmjs.com/package/magic-string , https://www.npmjs.com/package/@ast-grep/napi
