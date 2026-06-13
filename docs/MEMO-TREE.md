# メモの木（連想ナビゲーション）設計

ステータス: **段階1〜4 実装済み**（2026-06-13）。詳細は末尾「実装状況」

共有メモ（`data/notes/`）の読み書きを、plan と同じ「**op + 構造は code が保証、LLM は op を1つ出すだけ**」モデルに作り変える。狙いは2つ。

1. **書きのナイーブさを消す** — 今は「新規作成」か「全文 append」しかなく、既存ファイルは強制 append。推敲（既存本文の部分修正）が一切できなかった。これが「創作系タスクに成果物 doer が居ない」本丸の正体だった（[[project-future-agenda]]）。
2. **読みのナイーブさを消す** — 今は「1ファイル pick → 全文返す」だけ。メモが肥大化すると 30B のコンテキストで破綻する。

設計の背骨は **連想でたどる木（MOC ツリー）**。

## なぜ DECISIONS の「改変しない」を緩めてよいか

旧 MUST（DECISIONS §記憶とメモの扱い）は「**既存本文を LLM で要約・改変しない**」だった。この禁止の*本当の意図*は「LLM に本文を要約させて**記録を劣化させるな**（情報喪失・捏造）」であって、推敲そのものを禁じる意図ではない。

- **要約は引き続き禁止**（劣化するから）。
- **構造保存的な op 編集（厳密置換・セクション差し替え）は許可**。op は要約ではなく差分であり、対象を読み込み厳密一致を確認してから適用するため、情報の喪失・捏造が構造的に起きない。
- 不変条件「**read-before-edit**」と「要約しない」を**コードで強制**する（LLM の良心に頼らない）。

## 1. memo 単一 actor（read/write 統合）

`memoRead` を廃止し、`memo` 単一 actor に統合する。理由: 人間のメモ操作を分解すると **write は必ず read を内包**し（推敲＝読んでどこを直すか見る、追記＝重複を避けるため読む、新規＝既存に無いと確認する）、**read 単独だけが独立に存在**する（読み上げ）。だから read を write に内包させ、read 単独は `view` op に畳む。

```
memo actor が activate
  ├ フェーズ1【locate】対象メモを辿り verbatim ロード（read-before-edit）
  │   主=recall 認識（memo_index の top-k 一覧を見て「意図の対象」を認識・明確一致は必ず再利用）
  │   フォールバック=連想ディセント（木を降りる・browsing 的）
  └ フェーズ2【LLM が op を1つ】読んだ本文（**行番号付き**で提示）＋intent を見て:
       view            … 参照だけ（facts に本文を載せて終わり）← 旧 memoRead
       create          … 新規（どの枝に置くかも決める）
       append          … 末尾追記（リスト項目は1行間隔・散文は段落間隔を applier が出し分け）
       replace         … 厳密置換（read 済み本文と一致確認 → 純関数で適用）
       section_replace … markdown 見出し単位で差し替え
       replace_line    … 行番号で1行を差し替え（厳密文字列を作らせない＝弱モデルで堅い）
       delete_line     … 行番号で1行を削除（リスト項目の削除等）
       noop            … 触らない
```

> **locate は recall 認識を主にした**（当初は連想ディセント主・recall はフォールバックだった）。台帳のように同じノートへ繰り返し戻る用途で、木を盲目で降りる descent が「毎回新規に倒す＝断片化」する弱点を、top-k 一覧を見て*認識*する recall に替えて潰した（recall の認識 > ディセントの想起）。ディセントは browsing 的フォールバックとして温存。詳細は §3。

- **read-before-edit が構造で保証される**: フェーズ1が常に先行するので「逆次性問題」が消える。並列自律 actor の世界観を壊さず、1ターン内で read→edit を完結。
- op は純関数 applier で決定的に適用（plan の `applyPlanOp` と同じ哲学）。
- creative doer は**別 actor を作らない**。集中時にこの memo actor が成果物ファイルへ `append`/`section_replace` を出す形で自然に成立する。

## 2. メモ＝連想でたどる木（MOC ツリー）

各フォルダに `_index.md`（MOC = 目次）。葉が verbatim 本文。木は**サイズではなく話題で枝分かれ**する。

```
data/notes/
  _index.md                root MOC
    - [[lyrics/_index]]      歌・歌詞
    - [[band/_index]]        バンド運営
    - [[eva/_index]]         自分のこと
  lyrics/
    _index.md              branch MOC
      - [[01-新曲A]]  ## Aメロ / ## サビ
      - [[02-没ネタ]]
    01-新曲A.md            leaf（verbatim・真実）
```

### 真実 vs 派生ビュー（plan と同じ構図）

- **葉（verbatim 本文）＝真実**。LLM は要約・改変しない。
- **`_index.md`（MOC）＝派生ビュー**。子のリンク＋見出しを列挙した**機械生成物**。op 適用後に code が再生成し上書きする。生成物なので上書きしてよい（本文ではない＝改変禁止に抵触しない）。これは `data/plans/<id>.json`（真実）→ markdown（派生ビュー）と同型。

Obsidian で開けば `_index` が索引・葉が中身として navigable。エージェント側は `memo_index`（LanceDB、既存の `path_segments`/`depth_1〜3` 構造を流用）で引く。二重に navigable。

### 読み＝recall 認識（主）／連想ディセント（フォールバック）

**主経路（recall 認識）**: memo_index のベクトル想起で候補を top-k 出し、その**一覧を LLM に見せて「意図の対象」を*認識***させる（`recallRecognizeTarget`）。明確一致は**必ず再利用**（重複を作らない）。候補数件なら全部見えるので、想起ランキングが粗くても認識で当たる。台帳のように同じノートへ繰り返し戻る用途に頑健。

**フォールパック（連想ディセント）**: recall で認識できなければ木を降りる（`descendToTarget`）。
```
root _index を読む → 「歌詞の話だな」→ [[lyrics/_index]] へ
lyrics/_index を読む → 「新曲Aのサビだ」→ [[01-新曲A]] へ
01-新曲A.md をロード（verbatim）→ op
```
各ホップが「連想」そのもの。browsing 的な探索に向く。

### 書き＝木に置く

LLM は op に加えて *どの枝に置くか / 新しい枝を作るか* を決める（新規配置は LLM 可）。影響を受けた `_index.md` は code が機械再生成。

## 3. recall 認識を locate の主にした（2026-06-13 改訂）

当初は「連想ディセントを主・recall は後付けの層（フォールバック）」で設計した。だが実地で**台帳ユースケース（冷蔵庫在庫など、同じノートを繰り返し編集）が断片化**した——ディセントが既存ノートを認識できず毎ターン新規に倒したため。これは「木を盲目で降りる（想起）」より「top-k 一覧を見て選ぶ（認識）」の方が頑健、という RAG 流の知見そのもの。

そこで **locate を recall 認識（`recallRecognizeTarget`）を主に切り替えた**：
- memo_index のベクトル想起で候補を top-k（既定8）出す → **一覧を LLM に提示** → 意図の対象を*認識*して1つ選ぶ（`MEMO_RECALL_PICK_SYSTEM`）。
- **「明確一致は必ず再利用・重複作らない」** をプロンプトで強制 → 断片化を解消。
- 明確一致が無ければ null → **ディセントにフォールバック** → それも無ければ新規作成。

ディセント（連想ナビ・browsing の味）は捨てず、フォールバックとして温存。
※ 旧 `recallFallbackTarget`（距離閾値テレポート）は `recallRecognizeTarget` に置換。
※ さらに堅くするなら：entity/owner タグでの**同名異物（家/実家の冷蔵庫）識別**は未実装（次の subsystem）。

## 実装状況

ステータス: **段階1〜4 実装済み**（2026-06-13・テスト緑）。

| 段階 | 内容 | 状態 | 主なコード |
|------|------|------|-----------|
| 1 | memo 単一 actor（read/write 統合）＋ op 純関数 applier＋ DECISIONS 改訂 | ✅ 済 | `memo/ops.ts` `roles/memo.ts` `actors/memo.ts` |
| 2 | MOC ツリー（`_index.md` 機械再生成）＋ 連想ディセント | ✅ 済 | `memo/tree.ts` `memo/descent.ts` |
| 3 | **recall 認識を locate の主に**（断片化解消）。ディセントはフォールバックに | ✅ 済 | `descent.ts` `recallRecognizeTarget`／`MEMO_RECALL_PICK_SYSTEM` |
| 3b | **行 op**（`replace_line`/`delete_line`・本文を行番号付き提示）で削除/1行修正を堅く | ✅ 済 | `memo/ops.ts` `roles/memo.ts`(`numberLines`) |
| 3c | append のリスト/散文間隔の出し分け | ✅ 済 | `memo/ops.ts` |
| 4 | サイズ自動分割（予算超過を見出し境界でフォルダ化・verbatim） | ✅ 済 | `memo/tree.ts` `splitIfOversized` |
| — | entity/owner タグでの同名異物識別（家/実家の冷蔵庫） | 未実装 | 台帳の本格運用に要る次の subsystem |
| — | 入口/剪定（深い木向け recall 合成）、見出し無し巨大ファイルの byte ページング | 将来・エッジ | 現状の浅い木では不要 |

### テスト用 env

- `MEMO_NOTES_DIR` — メモ保存先ルートを差し替え（テスト隔離。既定 `data/notes`）
- `MEMO_MAX_LEAF_BYTES` — 葉の分割閾値（既定 `DEFAULT_MAX_LEAF_BYTES`=8000）

### locate→op の LLM 呼び出し回数（目安）

- memo_index に候補あり: recall 認識（1）＋ op（1）＝ **2回**（主経路）
- 候補ゼロ・新規 create: recall 認識スキップ（0）＋ ディセントも空ならスキップ＋ op（1）＝ **1回**
- recall で認識できずディセント: recall 認識（1）＋ ディセント（N）＋ op（1）

## 不変条件（MUST 候補）

- メモ本文（葉）の**要約・改変はしない**。LLM が触るのは op の選択＋ op が運ぶ差分の一文だけ。
- `replace`/`section_replace` は**対象を読み込み厳密一致を確認してから**適用する（read-before-edit）。一致しなければ失敗（盲目改変しない）。
- `replace_line`/`delete_line` は**行番号で狙う**（LLM に厳密文字列を再現させない）。本文は番号付きで提示し、コードが該当行を抽出・操作する＝弱モデルでも堅い。範囲外は失敗。
- locate は **recall 認識を主**にし、**明確一致が出たら必ず再利用**（重複ノートを作らない＝台帳の断片化を防ぐ）。
- `_index.md` は**機械生成物**。手書き本文を置かない・LLM に生成させない（子の列挙のみ）。
- op の適用は**純関数**で決定的に行い、LLM を呼ばない（構造は code が保証）。
