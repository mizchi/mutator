# stryker-js core / runners / checker 解析 (commit f2a49ff) — subagent 報告の保存版 (要点)

## フロー (core/src/stryker.ts:60-86)
Prepare (config/plugin/ProjectReader) → MutantInstrumenter (Babel 直列 instrument, preprocess, checker init, Sandbox.init: 全 file コピー + node_modules symlink) → DryRun (1 runner, overhead = gross - Σtest) → MutationTest (RxJS: earlyResult / check / NoCoverage / runner)

## Coverage
- header (instrumenter/src/util/syntax-helpers.ts:21-70): stryCov は currentTestId があれば perTest、なければ static
- planner (mutant-test-planner.ts:88-138): 非 static → covering tests、空なら NoCoverage / static → 全テスト + reloadEnvironment (ignoreStatic なら Ignored)
- timeout = 1.5*netTime + 5000 + overhead、hitLimit = hits×100 (:184-187)
- テスト順序最適化なし (fastest-first / killer-first なし)

## Incremental (incremental-differ.ts)
- 旧 report に埋め込んだ source と現 source を diff-match-patch で文字 diff → 位置補正
- mutant key = `file@sl:sc-el:ec\nmutator: replacement`、test key = `file@line:col\nname`
- reuse: Killed は旧 killer が 1 つ same なら / それ以外は covering test に added が無ければ / coverage off なら無条件
- test の end は「次 test の start」で推定 (:667-729)
- 制限: 依存モジュール・config・fixture 変更を検知しない / dry run は毎回フル / replacement 文字列に依存 / version・config hash なし / report に全 source 埋め込みで肥大

## Process model
- child_process.fork + JSON IPC + Proxy RPC、1 process = 1 mutant 同時
- decorator: Retry → ReloadEnv → MaxReuse → Timeout(kill & refork) → ChildProxy
- 切替: globalThis.__stryker__.activeMutant or env __STRYKER_ACTIVE_MUTANT__

## vitest-runner
- 1 process 1 Vitest (maxWorkers:1)。mutant ごとに provide('activeMutant') → ctx.start(files) で再評価
- testNamePattern を OR regex (同名テスト過剰実行)、filesMap.clear() hack、process ごと Vite server でメモリ重
- per-test coverage: setup file の beforeEach/afterEach で currentTestId、afterAll で suite.meta に書く

## typescript-checker
- SolutionBuilderWithWatch in-memory、import graph で祖先非重複の mutant を group 化、エラー group は個別再 check
- checker と runner で concurrency を半分ずつ

## ボトルネック (推定順)
1. mutant ごとの test run 起動 2. timeout 時の process 再生成 3. 単一 dry run 4. TS checker 5. Babel 直列 instrument 6. sandbox コピー 7. 順序非最適化で bail が効きにくい

## Design debt
typed-inject Context 肥大、RxJS、reloadEnvironment 1 bit の capability、多言語 offset 処理、JSON IPC + TCP logging、hack 群 (ts-nocheck 行補正, filesMap.clear)

## 示唆
oxc 並列 instrument + content hash ID / 常駐 runner で SUT 1 回ロード / covering tests を時間・kill 実績順に sort / 推移的依存 hash を key に dry run coverage も cache / tsgo 常駐 checker
