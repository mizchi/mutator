# cargo-mutants 解析 (HEAD 9b09f6c) — subagent 報告の保存版 (要点)

## 生成
- syn Visit (src/visit.rs:451-922)、span テキスト置換 (mutant.rs:140, span.rs:102)、marker comment 付与
- Genre: FnValue / BinaryOperator / UnaryOperator(削除のみ) / MatchArm / MatchArmGuard / StructField (mutant.rs:22)
- FnValue: 戻り値型 (構文のみ、last path segment) から再帰的に値生成 (fnvalue.rs:33-261)。型推論なし、外れは unviable
- 演算子: == ↔ !=, && ↔ ||, < → ==,>,<= / > → ==,<,>= / <= → > / >= → <, + → -,* / -,* → +,/ / / → %,* / % → /,+ / << ↔ >> / & → |,^ ...
  - 意図的に生成しない: == → <= (unsigned 0 比較で等価), |= → ^= (等価になりやすい)
- skip: 置換値 == 元 body 文字列 (visit.rs:466-482)、unsafe、test attr、mutants::skip、impl 内 new、impl Default、skip_calls (with_capacity) 内、const/static
- match arm 削除は `_` arm があるときのみ、guard 付き arm は削除しない (guard=false と等価)。struct field 削除は `..base` があるときのみ
- ID: "{file}:{line}:{col}: {desc}" → 行がずれると別 mutant 扱い (弱点)

## --in-diff (in_diff.rs:93-264)
- git を呼ばず diff ファイルを flickzeug で parse。`b/` prefix のみ strip、.rs 以外と /dev/null 無視
- affected lines (new 側行番号): Insert 行 / Delete は前後行 (lineno-1 と次の new 行)。Context は含めない
  - 1 行挿入→[i]、1 行削除→[i-1,i]、置換→[i-1,i,i+1]
- mutant span の各行を sorted Vec に binary_search、1 行でも当たれば採用
- 整合性: diff の new 側 (Context+Insert) を実ファイルと突き合わせ、不一致は exit 5 (in_diff.rs:159)
- 空 diff / 対象なし は exit 0。rename-only は hunk 0 で何もしない (#580)
- 限界: テストのみ変更は拾えない / FnValue span は body のみでシグネチャ変更を拾わない / 関数内の 1 行変更で FnValue は全部選ばれるが他行の operator mutant は選ばれない / サブディレクトリ crate の path ずれ

## 実行
- 1 mutant: overwrite → cargo build → cargo test → revert (lab.rs:256-326)。build dir は tempdir に copy (reflink 優先, copy_tree.rs)
- 並列: worker ごとに build dir、queue は Mutex<IntoIter>
- baseline 失敗で exit 4。timeout = baseline test 時間 ×5 (下限 20s, timeouts.rs:56)。killpg で process group kill
- outcome 優先: Unviable(build 失敗) > Timeout > Caught > Missed (outcome.rs:262)。exit: 4 > 3 > 2 > 0, 5=diff mismatch
- shard k/n (slice default / round-robin)。--iterate: 前回 caught/unviable を名前一致で除外
- INSTA_UPDATE=no 等で snapshot 自動更新を禁止 (cargo.rs:47-53)

## 出力
- mutants.out/{mutants.json (開始前全件), outcomes.json (逐次), diff/, log/, caught|missed|timeout|unviable.txt, lock.json}
- GitHub annotation: missed のみ `::warning file=,line=,col=,endLine=,endCol=` (annotation.rs:52)

## JS/TS への転用
- 採用: TS 型注釈ベース FnValue / 同一文字列 skip / switch default・spread 条件 / ==→<= 等の除外 / 単項は削除のみ / diff 整合チェック + exit code 設計 / baseline + 自動 timeout / process group kill / shard / iterate / annotation / snapshot 更新禁止
- 置換: tree copy → vite transform hook + mutation switching、per-test coverage でテスト選択、位置非依存 ID (file + qualified fn + genre + 関数内出現順 + replacement) で結果キャッシュ
- in-diff 改良: git 内部呼び出し (merge-base, -M --no-prefix)、区間交差、関数単位モード (関数全体 span で判定しシグネチャ変更を拾う)、テスト変更 → coverage 逆引きで mutant 選択、rename map でキャッシュ継承
- バグ候補: StructField が allows_mutant を通らず --exclude-re が効かない (visit.rs:953-967)
