# mutator 設計メモ (draft)

調査元: `docs/research/` (stryker-js f2a49ff / cargo-mutants 9b09f6c / pitest 1.22.0 / Google・Meta 論文 / parser ベンチ)。2026-10-08 時点。

## ゴール

- vitest 前提の高速な JS/TS mutation testing
- **差分駆動**: 変更箇所だけ mutate し、変更に関係するテストだけ流し、それ以外は前回結果を再利用
- コアは小さく独立したライブラリ (vitest / Node fs / プロセス管理に依存しない)

## stryker が遅い理由 (調査結論)

1. mutant ごとに test run を起動し直す (vitest: `ctx.start` で module 再評価、jest: `runCLI`)
2. sandbox に全ファイルコピー + timeout 時は process 再 fork
3. dry run が単一 process・毎回フル
4. テスト順序最適化なし → bail が効かない
5. incremental が弱い: 位置 + replacement 文字列 key、依存変更を検知しない、dry run を省略できない
6. Babel 直列 instrument + mutant ごと deep clone (O(M×S)) + 全文再印字 (ただし wall time への寄与は小)
7. 多ランナー抽象 (typed-inject / RxJS / reloadEnvironment 1 bit capability) による複雑さ

## レイヤ構成

```
@mutator/core      純関数のみ。入力: (path, source, options) / diff / 前回 cache。出力: データ
  ├─ instrument    oxc-parser + magic-string。{code, map, mutants[]} を返す
  ├─ mutators      (node, parents, src) -> Replacement[] の純関数群
  ├─ identity      MutantKey / ScopeHash の算出
  ├─ diff          unified diff parse → changed ranges → mutant 選択
  ├─ plan          coverage + cache → 実行計画 (どの mutant をどのテスト順で)
  └─ cache         再利用判定 (保存形式はシリアライズ可能なデータのみ)
@mutator/vitest    vite plugin (enforce:'pre', transform で core.instrument)、Vitest Node API 駆動、
                   provide('activeMutant') 切替、per-test coverage 収集、worker pool、timeout
mutator (cli)      git 呼び出し、fs、レポート出力
```

instrument が純関数なので、後で Rust napi (oxc_semantic が必要になった時など) に差し替え可能。

## instrument (stryker から継承 + 改善)

- **継承**: mutation switching、自己書き換え lazy ヘルパ、`globalThis` namespace、hitLimit による無限ループ検出、static/perTest coverage 振り分け、最寄りの置ける祖先への自動繰り上げ、`.name` 保持、`&&`/`||` 文脈での等価削減、ignored mutant も報告
- **改善**: AST clone/再印字をやめ span + テキスト合成 (書式保持・sourcemap 付き)、post-order で入れ子 mutant を合成、2 パス採番で ID 欠番なし、`as`/`satisfies` を一貫して扱う (型部分のみスキップ)
- **自前ガード必須**: 括弧付け、ASI、宣言文/label 付きループ/case 内 lexical を statement placer で包まない
- 無効化コメントは `Program.comments` から行ベースで定義し直す

## mutator 方針

- stryker 17 種をベースに、cargo-mutants の **FnValue** (TS 戻り値型注釈から値を生成: boolean→true/false、number→0/1/-1、string→""/"xyzzy"、T[]→[]、Promise<T>→…) を追加
- cargo-mutants 由来の除外: `==`→`<=` 系の等価になりやすい置換を作らない、単項は削除のみ、置換値が元と同一なら skip、switch case 削除は default がある時のみ
- **arid node 抑制** (Google: `arid(n) = simple(n) ? expert(n) : children.every(arid)`): console/logger、tracing/metrics、`Date.now`、`process.env.NODE_ENV` / `import.meta.env`、`Math.min/max` 引数、`end/flush/close`、assert/invariant メッセージ等。ルールは設定で宣言的に追加可能に
- オプション: 1 行 (1 statement) 1 mutant モード (Google: changelist あたり 820 → 7)

## 差分駆動の高速化 (本命)

### 1. Mutant identity (位置非依存)

```
MutantKey = hash(file, scopePath, astPathInScope, mutatorId, replacement)
ScopeHash = hash(囲む関数の正規化 AST; コメント・空白・型注釈を除外)
```

- 行・列を key に入れない (stryker / cargo-mutants / PIT はここが弱い)
- 関数の ScopeHash が変わったらその scope の mutant は新規扱い (mutmut 方式)
- top-level は statement 単位で 1 scope

### 2. 結果キャッシュと再利用判定 (PIT 1.22 + 依存 hash)

| 前回 | 再利用条件 | 不成立時 |
|---|---|---|
| Killed | ScopeHash 不変 & 前回 killer が存在し不変 | killer を先頭に再実行 |
| Survived | ScopeHash・depsHash・被覆 test 不変 & 被覆 test の追加なし | 追加/変更 test を先頭に |
| NoCoverage | ScopeHash 不変 & 被覆 0 のまま | 通常 |
| Timeout | ScopeHash & depsHash 不変 | 通常 |

- `depsHash`: runtime call graph (なければ import graph) で到達する ScopeHash の Merkle 合成。stryker / PIT が見ていない依存先の変更を拾う
- `env` (lockfile / tsconfig / vitest config / node / tool / mutator set version) が変われば全無効化
- 結果は filter 前の生データで保存。中断時も部分保存
- **coverage 計測 (dry run) 自体も差分化**: 変更 scope に触れうる test + 新規/変更 test だけ再計測

### 3. diff スコープ (cargo-mutants --in-diff の改良版)

- git を内部で呼ぶ (`merge-base`、`-M --no-prefix`)。外部 diff 入力時は new 側テキストと実ファイルの整合チェック (不一致は専用 exit code)
- 判定は行ではなく **区間交差**。`--scope=node|function` で関数単位モードも提供し、シグネチャ変更も拾う
- **テストのみ変更** → そのテストが被覆する Survived/NoCoverage を再実行 (cargo-mutants は何もしない)
- rename は old→new マップでキャッシュ継承

### 4. テスト選択と実行順

- per-test coverage で絞る (主)、`vitest related` 相当の module graph (補助)
- 順序: 前回 killer → 兄弟 mutant の killer → 直接 hit するテスト → 実行時間短い順。bail 1
- mutant は推定時間の短い順に流す
- timeout: 選んだテスト群の baseline × factor + const

## 実行モデル (vitest adapter)

- PoC 済み (`docs/research/analysis-parsers.md`): `createVitest` に `enforce:'pre'` plugin を渡し in-memory instrument、`provide` + `runTestFiles` で切替。transform は 1 回、1 mutant ≈ 50ms
- sandbox コピー不要 (fs に書く non-hermetic テスト用に opt-in で残す)
- static mutant は別キューで module 再 import
- worker pool は Vitest インスタンス常駐を N 個。timeout 時のみ再生成
- snapshot 自動更新を禁止 (cargo-mutants の INSTA_UPDATE=no 相当)

## 出力 (cargo-mutants 準拠)

- `mutants.json` (開始前全件) / `outcomes.json` (逐次) / 各 mutant の diff / GitHub annotation (`::warning` で missed のみ)
- exit code: baseline 失敗 > timeout > survived > 0、diff 不整合は別コード
- shard `k/n`、`--list --json`

## 実装状況 (2026-10-08)

- [x] core: instrument (18 mutators, 配置 3 種, ASI ガード), identity, scope hash, diff, plan
- [x] vitest: plugin, setup (perTest / static coverage, provide/inject 切替), Session
- [x] cli: dry run → plan → 実行 → snapshot, `--since`, レポート, GitHub annotation
- [x] 無効化コメント (`// mutator-disable-next-line`, Stryker コメント互換)
- [x] 並列実行 (Session を N 個, `-j`)
- [x] dry run の差分化 (snapshot に test index / static / touched を保存し、影響を受けるテストファイルだけ再収集)
- [x] path-portable な key / snapshot (CI キャッシュ可)
- [x] early exit は vitest `bail` ではなく reporter 観測 + cancel (bail は kill を取りこぼす)
- [x] FnValue mutator (TS 戻り値型)、Regex (weapon-regex level 1 相当の自前実装)、CallExpression (`call();` → `;`、throw は対象外)、`for (;;)` → `for (;false;)`
- [ ] arid node 抑制
- [ ] test fingerprint を module graph 込みにする (現状はテストファイル内容のみ)
- [x] ~~1 run で複数 mutant~~ 試して取り下げ: 速くなったのは run 内の Vitest worker 並列の分で、固定コスト償却ではなかった。`-j 1` では 186s→116s だが既定の `-j 6` では 57s→85s と悪化 (early exit が効きにくく tail が伸びる)

## ベンチマーク (unjs/ufo, 7 files / 489 tests, M3 Pro 12 cores, 2026-10-09, 負荷なし)

| run | mutator | stryker 10 |
|---|---:|---:|
| cold (並列, 既定) | **29s** (1109 mutants, 83.9%) | 36s (1016 mutants, 82.6%) |
| 変更なし再実行 | **0.33s** | 3.5s (`--incremental`) |
| 1 関数編集後 | **1.0s** (`--since HEAD`, 18 実行) / 10.7s (全体, 48 実行) | 3.8s (`--incremental`) |

- 両者が生成する mutant の判定は一致。mutator 別の生成数・検出数もほぼ同じ。
- 計測上の注意 (実際に踏んだもの):
  - ufo clone 内に残っていた `.stryker-tmp/sandbox` のテストを重複して拾うと 2 倍遅くなる (Vitest の既定 exclude に入っていない)
  - forks pool の worker が無限ループ mutant の timeout 後に孤児プロセスとして残り、CPU を食い続けていた (threads pool 既定化で解消)。これが残っていると全計測が 2〜3 倍ぶれる。以前の表の数値 (54s / 57s / 186s 等) はこの影響を受けている

## 未決事項

- parser: oxc-parser (npm, raw transfer) を採用予定。oxc は 0.x で breaking change が多いので version pin
- 型エラーになる mutant (unviable) の扱い: tsgo 常駐で事前 check するか、実行時 TypeError を killed とするか
- stryker の report schema (mutation-testing-elements) 互換を取るか
- Vue/Svelte SFC 対応の優先度
