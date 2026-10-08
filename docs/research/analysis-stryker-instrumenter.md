# stryker-js instrumenter 解析 (f2a49ff, Babel 8) — subagent 報告の保存版 (要点)
パスは packages/instrumenter/src/ 起点

## パイプライン
- instrumenter.ts:37-83: ファイル直列に parse → transformBabel (1 traverse で mutant 生成+配置) → @babel/generator 全文再印字 (sourceMaps:false)
- dispatch parsers/create-parser.ts:48-78: JS (Babel + stage-1, ユーザー babel config を読む) / TS,TSX (preset-typescript, legacy decorators) / HTML,Vue (angular-html-parser で <script> 抽出) / Svelte (preprocess placeholder + remap)
- ID はグローバル連番 (mutant-collector.ts)、filter で欠番発生

## Mutator カタログ (mutators/mutate.ts:20-38, 17 種)
| name | 変換 | ガード |
|---|---|---|
| ArithmeticOperator | + ↔ -, * ↔ /, % → * | オペランドが文字列/テンプレなら除外 |
| ArrayDeclaration | [a]→[], []→["Stryker was here"], Array(x)→Array() | callee は Array 識別子のみ |
| ArrowFunction | () => expr → () => undefined | block body / 既に undefined は除外 |
| AssignmentOperator | += ↔ -=, *= ↔ /=, %=→*=, <<= ↔ >>=, &= ↔ \|=, &&= ↔ \|\|=, ??=→&&= | 右辺文字列で非論理代入は除外 |
| BlockStatement | {...} → {} | 空除外、constructor で super()+param property/初期化 field 時除外 |
| BooleanLiteral | true ↔ false, !x → x | |
| ConditionalExpression | ループ test→false, if test→true/false, 比較/論理→true/false (親 \|\| なら false のみ、&& なら true のみ), case consequent 空 | fallthrough case 除外 |
| CallExpression | call(); → ; / throw → ; | super() 除外、サブツリー内唯一の mutant の時のみ |
| EqualityOperator | < → <=,>= / <= → <,> / > → >=,<= / >= → >,< / == ↔ != / === ↔ !== | |
| LogicalOperator | && ↔ \|\|, ?? → && | |
| MethodExpression | charAt/filter/reverse/slice/sort/substr/substring/trim 除去、startsWith↔endsWith, every↔some, toUpper↔toLower, trimStart↔trimEnd, min↔max, setX 系 | obj.ident 形のみ |
| ObjectLiteral | 非空 {} → {} | |
| StringLiteral | "" ↔ "Stryker was here!", 非空→"" (template も) | import/export/JSX attr/型/key/require/Symbol/import() 除外 |
| UnaryOperator | +x ↔ -x, ~x → x | |
| UpdateOperator | ++ ↔ -- | |
| Regex | weapon-regex level 1 | |
| OptionalChaining | a?.b → a.b 等 | |

- スキップ (syntax-helpers.ts:160-216): TSAsExpression サブツリー丸ごと (`(a+b) as T` も対象外、satisfies は対象 = 非対称), enum, decorator, import, 型ノード, declare

## 配置 (mutation switching)
- 全 expression/statement を placementMap に登録 → mutant を最寄りの「置ける祖先」に紐付け、enter で clone に 1 mutation 適用、exit で placer が置換 → 各分岐は「原文 + 1 mutation」
- expression: `act("2") ? m2 : act("1") ? m1 : (stryCov("1","2"), orig)` / statement: if-else chain / switch-case: case 内 if-else
- 置けない位置: object key, member/call チェーン途中 (this と ?. 短絡保護), tagged template, delete オペランド, 代入左辺 → 親へ繰り上げ
- .name 保持のため無名 function/arrow に名前付与 / IIFE
- 潜在バグ: label 付きループを if で包むと continue label 破壊、switch-case placer が case 内 let/const スコープ変更、HTML offset 列ずれ疑い

## ランタイムヘッダ (syntax-helpers.ts:21-70)
stryNS (globalThis.__stryker__ + env __STRYKER_ACTIVE_MUTANT__ fallback) / stryCov (currentTestId で perTest/static 振り分け) / stryMutAct (hitCount > hitLimit で throw → 無限ループ検出)。関数宣言 hoisting + 自己書き換え lazy init。

## 無効化
- `// Stryker disable|restore [next-line] names[: reason]`、Babel leadingComments 依存 → oxc では行ベースで再定義が必要
- 優先: コメント → excludedMutations → ignorer。ignored も報告するが配置しない
- Ignorer API は Babel NodePath 直結 (パーサ非互換の最大要因)

## Static mutant
- dry run で currentTestId 不在時の hit = static → 環境 reload + 全テスト必要。ignoreStatic で Ignored
- planner: mutant-test-planner.ts:88-216

## 外部契約
{id, location, mutatorName, replacement 文字列} のみ。typescript-checker は文字列スプライスで適用 (script-file.ts:27) → テキストスプライス方式で互換可能

## 性能
- perf 閾値 22.8KB/948 mutant で 325ms (~70KB/s)
- コスト: Babel parse+config 解決 > scope 付き traverse > placementMap 操作 > Mutant.applied の deep clone O(M×S) > generator 全文再印字 > disableTypeChecks 再パース > 直列
- oxc 化で効く: span+テキスト合成 (clone/再印字廃止、書式保持、sourcemap)、並列化。ただし wall time はテスト実行支配

## テキスト方式で自前ガード必要
全置換を括弧で囲む、ASI (式文先頭 `(` に `;`)、`**` と単項、for-init 内 `in`、new callee、arrow object body、宣言文を if で包まない、label、case 内 lexical

## 真似すべき / レガシー
- 真似: mutation switching + lazy helper + globalThis ns、hitLimit、static/perTest 分類、最寄り祖先への自動繰り上げ、.name 保持、&&/|| 等価削減、ignored も報告、丁寧な配置エラー
- 捨てる: Babel NodePath API、ユーザー babel config、stage-1/Flow、全文再印字、TSAs 丸ごとスキップ、ID 欠番、Svelte/HTML ハック、new Function fallback
