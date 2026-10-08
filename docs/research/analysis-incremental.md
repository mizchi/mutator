# 差分検出 / incremental 手法調査 — subagent 報告の保存版 (要点)

## identity
- PIT: 命令 index (MutationIdentifier.java:29-43) / Stryker: file@line:col + mutator + replacement + diff-match-patch 再配置 / mutmut: 関数名 + 連番 + 関数 hash 無効化 (__main__.py:198-215)
- 推奨: MutantKey = hash(file, scopePath, astPathInScope, mutatorId, replacement)。行列は入れない。ScopeHash = 正規化 AST (コメント/空白/型注釈除外) の hash、変われば scope 内 mutant は新規

## cache 再利用判定 (PIT 1.22.0 IncrementalAnalyser:73-111 を拡張)
| prev | 再利用条件 | 不成立時 |
|---|---|---|
| Killed | scope 不変 & killer 存在・不変 | killer 先頭で再実行 |
| Survived | scope・depsHash・被覆 test 不変 & test 追加なし | 追加/変更 test 先頭 |
| NoCoverage | scope 不変 & 被覆 0 のまま | 通常 |
| Timeout | scope & deps 不変 | 通常 |
| env (lockfile/tsconfig/runner config/node/tool/mutator ver) 変化 | 全無効 or warn (mutmut on_dependency_change) | |
- depsHash: runtime call graph (or import graph) 到達 scopeHash の Merkle 合成 ← PIT/Stryker の穴
- 結果は interceptor 適用前の生データで保存 (PIT HistoryResultInterceptor)
- coverage 計測自体も差分化 (PIT History.limitTests, mutmut の新規 test のみ再収集)
- PIT 1.23.0 以降 history は arcmutate 有償プラグインへ移動

## diff スコープ
- Google / cargo-mutants / Mull gitDiffRef / gremlins: changed hunk ∩ covered lines のみ mutate
- test のみ変更 → その test が覆う Survived を再実行 (Stryker の added 規則)
- test 選択: per-test coverage 主、call graph → module graph (vitest related) 補助
- 全体スコアは定期 full run かサンプリング (Gopinath 2015)

## ranking / early exit
- 前回 killer → 兄弟 mutant の killer → 直接 hit test (+1000 bonus, TestInfoPriorisationComparator.java:41-53) → 速い・狭い test。bail 1
- mutant は推定時間短い順 (mutmut :1014) or survivability 順 (Google)
- weak mutation 事前チェック: mutated 値 vs original 値を比較、infection しない test を外す。0 件なら equivalent 候補

## arid (Google: arid(n) = simple(n) ? expert(n) : children.every(arid))
- 中央値 820 → 77 (1 行 1 mutant) → 7 (+arid)、productive 80% → 89%
- JS ルール案: console/logger/debug, performance/OTel/metrics/Sentry, Date.now/performance.now/timer 値, new Array(n)/Buffer.alloc, NODE_ENV/import.meta.env/import.meta.main, ===↔==, Math.min/max/clamp 引数, length<0 類, memo lookup, end/flush/close, toString/toJSON/getter, TS 型構文 (as/satisfies/!/declare/.d.ts), 生成コード, assert/invariant 引数・エラーメッセージ
- ast-grep/設定で宣言的に、ユーザーの not-useful フィードバックで育てる

## 等価・冗長削減
- TCE (C: equivalent 7%, duplicate 21%) → JS 近似: mutated scope を minify した hash 比較
- subsumption (kill matrix 蓄積)、mutant schemata (Untch 1993)、EMS 軽量版

## 参考 URL
Google 2018 https://research.google/pubs/state-of-mutation-testing-at-google/ / 2021 https://arxiv.org/abs/2102.11378 / Meta https://arxiv.org/abs/2010.13464 / Stryker incremental https://stryker-mutator.io/docs/stryker-js/incremental/ / Mull https://mull.readthedocs.io/en/0.31.0/IncrementalMutationTesting.html / TCE https://orbilu.uni.lu/bitstream/10993/20289/1/ICSE15.pdf / ReMT https://userweb.cs.txstate.edu/~rp31/papersSSE/regrMuteTest.pdf
補助ソース: scratchpad/pit122/, scratchpad/ext/
