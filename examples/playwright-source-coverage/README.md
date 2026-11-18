# Playwright のソースカバレッジのサンプル

Vite + TypeScript の小さなアプリです。カートは個数から金額を計算し、プロフィールは入力した名前を大文字にします。E2E は画面の操作と表示だけを検証し、アプリのソースを import しません。

`mutator.config.ts` で Playwright と追加のソースカバレッジを明示的に有効にしています。このサンプルはリポジトリ内のワークスペース版を使います。

```ts
runner: 'playwright',
playwrightSourceCoverage: true,
```

Chromium 限定です。変異ごとにブラウザテストを実行するため、通常の E2E より時間がかかります。このサンプルでは最大2並列・60秒の予算を設定しています。大きなプロジェクトの負荷は[ベンチマーク](../../docs/playwright-coverage-benchmark.md)を参照してください。

## 実行

Node.js 24 以降、pnpm、Git、Chromium が必要です。`just` がある場合は同梱の `justfile` から操作できます。

```sh
# リポジトリのルートで
pnpm install --frozen-lockfile
pnpm --dir examples/playwright-source-coverage exec playwright install chromium

cd examples/playwright-source-coverage
just typecheck
just verify
```

`just verify` は `pnpm run verify` と同じです。空きポートと一時コピーを使い、チェックインされたソースや手元の `.mutator/` は変更しません。実行ログと `result.json` は表示された `.tmp/verify-*/` に残ります。成功時はコピーを削除し、失敗時は調査用に残します。コピーを成功時にも残すには `node scripts/verify.ts --keep` を使ってください。

個別に動かす場合:

```sh
just dev       # http://127.0.0.1:4180/cart と /profile
just test      # 通常の Playwright E2E
just mutate    # mutator.config.ts を使って変異テスト
```

`just test` と `just mutate` はサーバーを自分で起動するため、手動起動した `just dev` は先に停止してください。テスト用ポートが使用中なら `PLAYWRIGHT_SAMPLE_PORT=4181 just test` のように変更できます。`just verify` は自動で空きポートを選びます。

## 何を確認するか

すべての画面で同じエントリーモジュールをロードしても、実際に呼ぶ関数は画面ごとに異なります。ソースマップ付き V8 カバレッジから、次の対応を取得します。

| 元ソースの関数 | 到達した E2E |
|---|---|
| `src/cart.ts#calculateTotal` | `e2e/cart.spec.ts#calculates the total` |
| `src/normalize-quantity.ts#normalizeQuantity` | `e2e/cart.spec.ts#calculates the total` |
| `src/profile.ts#formatDisplayName` | `e2e/profile.spec.ts#formats the display name` |

`normalizeQuantity` は `ArrowFunction` 変異を設定で除外し、意図的に変異候補を0件にしています。従来の変異箇所の到達情報だけでは、この関数自体の対応を記録できません。追加のソースカバレッジでは記録でき、変更時にカートの E2E を選べます。

検証スクリプトは一時コピーを Git リポジトリにして基準コミットを作り、通常の Playwright CLI と mutator CLI を実行します。

1. 通常の E2E が2件とも成功する。
2. 初回の変異テストが9件をすべて検出し、上の対応を snapshot に記録する。計測が不完全なテストは0件。
3. 変更なしで再実行すると、E2E の再計測と変異の実行はともに0件。
4. 補助関数を `quantity => quantity` から `quantity => Number(quantity)` に変更しても、変異候補は0件のまま。`mutator select-tests --since HEAD --format json` はカートの E2E だけを選ぶ。
5. 差分実行はカートの E2E だけを再計測し、影響する変異を再実行する。プロフィールの判定は再利用する。
6. その状態からもう一度実行すると、再計測と変異実行は0件。
7. 編集済みコピーのキャッシュを消してフル実行し、差分実行と全変異の判定が一致する。

確認結果（2026-11-18、Node v24.22.2）:

| 実行 | E2E 再計測ファイル | 変異実行 | 判定再利用 |
|---|---:|---:|---:|
| 初回 | 2 / 2 | 9 | 0 |
| 変更なし | 0 / 2 | 0 | 9 |
| 補助関数の変更後 | 1 / 2 | 5 | 4 |
| 変更後の再実行 | 0 / 2 | 0 | 9 |
| 編集済みソースのフル実行 | 2 / 2 | 9 | 0 |

この例は各 E2E が1ページだけを開きます。複数回の遷移、popup、worker などで計測が欠ける場合は、`sourceCoverageIncomplete` に記録され、候補を広く残します。到達していることと、assertion が変更を検出できることは別です。
