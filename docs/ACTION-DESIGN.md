# 抽象 ACTION 設計（v0.4）

ステータス: **v0.4 実装済み**  
方針: ジャッジは「できることの種類」だけ選ぶ。各 **サブモジュール**が言語野くんと同型に LLM で頑張る。

**二系統**: 記憶（LanceDB）とメモ（ファイル）を、**読む／書く／覚える／思い出す**で対称に分ける。

### 記憶 vs メモの鮮明さ

| | エピソード記憶（LanceDB） | 共有メモ（ファイル） |
|--|---------------------------|----------------------|
| 性格 | 会話のふんわりした想起 | 意図して残した全文 |
| LLM | 想起・`recall` で要約・圧縮してよい | **既存本文の要約・改変はしない** |
| 重さ | 距離・提示濃さでぼかす | ファイルはそのまま全部渡す |

非採用: `router.ts` ヒューリスティック、tool JSON 行動くん、Planner 中間層。

---

## 1. ジャッジのカタログ（5種）

ジャッジが選べるのはこの一覧だけ。

| kind | 日本語（プロンプト表示） | いつ選ぶか |
|------|--------------------------|------------|
| `none` | 何もしない | 行動不要 |
| `remember` | 覚えておく | 会話の事実・好み・約束を**記憶に**残したい |
| `recall` | 思い出す | **記憶から**もう少し掘り出したい |
| `memo_write` | メモを書く | **共有メモファイルに**新しく書き残したい |
| `memo_read` | メモを読む | **既存のメモファイルを**確認したい |

### ジャッジ向けの目安

| ユーザーっぽい言い方 | kind |
|----------------------|------|
| 覚えて、忘れないで | `remember` |
| 前に話したこと、思い出して | `recall`（記憶） |
| メモに書いて、リストに残して | `memo_write` |
| メモを見て、さっきのメモ読んで | `memo_read` |

取り違えても致命傷ではないが、**読む系は `recall` と `memo_read` を分ける**と意図が通りやすい。

### スキーマ

```json
{
  "ACTION": { "kind": "memo_read", "intent": "買い物リストのメモ" },
  "REPLY": true,
  "NEXT_STATE": "対話"
}
```

- `ACTION` は常に object。`kind: "none"` のとき `intent: ""`。
- それ以外は `intent` 必須。

ジャッジプロンプト:

> 選べる ACTION: none, remember（覚えておく）, recall（思い出す）, memo_write（メモを書く）, memo_read（メモを読む）。

---

## 2. 行動くん = ディスパッチ

```typescript
switch (kind) {
  case "none": return notAttempted;
  case "remember": return runRemember(llm, intent, ctx);
  case "recall": return runRecall(llm, intent, ctx);
  case "memo_write": return runMemoWrite(llm, intent, ctx);
  case "memo_read": return runMemoRead(llm, intent, ctx);
}
```

行動くん自身は LLM を呼ばない。

---

## 3. サブモジュール一覧

| kind | サブモジュール | 機械処理 | LLM の仕事 |
|------|----------------|----------|------------|
| `remember` | 覚えるくん | LanceDB append | ファクト文を考える |
| `recall` | 思い出すくん | LanceDB vector search | 候補を LLM で bullet 要約 |
| `memo_write` | メモを書くくん | `data/notes/` に write | 新規本文・ファイル名を考える |
| `memo_read` | メモを読むくん | list / read ファイル | どのファイルか選ぶ（本文は改変しない） |

---

## 4. 思い出すくん — `recall`

- **記憶（LanceDB）だけ**。メモファイルは見ない（それは `memo_read`）。
- プリプロセスの自動想起とは別: ジャッジが「今、意識的に」思い出すとき。

処理: `embed(intent)` → top-k → LLM が意図に沿って `facts.bullets` に要約（パース失敗時のみ機械フォールバック）

---

## 5. 覚えるくん — `remember`

- LanceDB に `source: "remember"` でファクト追記。
- 内省（`source: "introspection"`）と役割分離。同ターン両方あり得る。

処理: LLM がファクト文 → 機械 append

---

## 6. メモを書くくん — `memo_write`

- 共有メモ `data/notes/*.md`。
- LLM: `{ content, filename? }` → 機械 write（path 安全処理のみ）

`summary`: 「〇〇.md にメモを書いた」

---

## 7. メモを読むくん — `memo_read`

- `intent` からどのメモかを LLM が決める（一覧をプロンプトに渡す）。
- 機械: `list_notes` → 該当 file `read` → **全文を `facts.body` に載せる（要約しない）**

メモは重くても全部覚えている扱い。言語野が口頭で短く言うのはセリフの問題であり、ここでは本文をいじらない。

「メモを読んで」と言われたときに `recall` を選ばないよう、ジャッジが `memo_read` を選ぶのが正道。

---

## 8. プリプロセスとの関係

| 機能 | 誰 | 何 |
|------|-----|-----|
| 自動想起 | プリプロセス（機械） | 毎ターン、作業台用に LanceDB top-k |
| `recall` | 思い出すくん | ジャッジ指示時、記憶を深掘り |
| `memo_read` | メモを読むくん | ジャッジ指示時、ファイルを読む |

三つは共存。役割が違う。

---

## 9. ごっちゃについて

- **書き込み**: `remember` と `memo_write` は保存先が違うだけ。両方同時はジャッジが2回選ばない限り起きない。
- **読み出し**: `recall`（記憶）と `memo_read`（ファイル）を分けたので、v0.3 より混線しにくい。
- それでも 8B が `recall` / `memo_read` を逆にしたら、次ターンで直せる程度の問題。

---

## 10. ターンの流れ

```
プリプロセス（自動想起）→ ジャッジ → 行動（5種のいずれか）→ 言語野 → 内省 → 内省を LanceDB
```

`remember` は手順「行動」で既に LanceDB に書く。内省は別行。

---

## 11. 実装順

1. 型・ジャッジ schema（5 kind）
2. ディスパッチ + `roles/remember`, `recall`, `memo-write`, `memo-read`
3. `router.ts` 削除、旧 action 置換
4. プロンプト・テスト

---

## 12. kind 名について

コード上は `memo_write` / `memo_read`（英語・enum 向き）。  
ジャッジプロンプトとログでは **メモを書く / メモを読む** と日本語表示。

`jot` は v0.3 から改名（書くだけだったのを、読むと対にした）。
