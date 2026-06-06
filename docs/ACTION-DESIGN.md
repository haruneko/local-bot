# 抽象 ACTION 設計（v0.5）

ステータス: **v0.5 実装済み**  
方針: ジャッジは **抽象3カテゴリ**だけ選ぶ。各 **カテゴリサブエージェント**がツールを選び実行する。

## カテゴリ（意図軸）

| kind | 日本語 | 意味 |
|------|--------|------|
| `none` | 何もしない | 行動不要 |
| `memory` | 記憶 | 自分の永続状態だけを変える（LanceDB・notes） |
| `research` | 探索 | 外から情報を取り込む（MCP: web・予定照会・センサー） |
| `express` | 発信 | 外の世界を変える/他者に見える（MCP: SNS・予定登録） |

思索はアクションではない。記憶操作（`recall` / `distill`）として `memory` に吸収する。

## レイヤモデル（用語の整理）

「層」を 2 つの意味で使い分ける。混同しないこと。

### A. 認知の3層（ターン全体のパイプライン）

エージェント1ターンの流れは **入力 → 判断 → 行動/出力** の3層。

```
[入力層] プリプロセス
  センサー・永続記憶・作業記憶から揮発コンテキスト（TurnContext）を組み上げる
       ↓
[判断層] ジャッジ
  none | memory | research | express + intent / REPLY / NEXT_STATE を決める
       ↓
[行動・出力層] サブエージェント → 出力
  - 行動: カテゴリサブエージェントがツールを実行（下記 B の2段）
  - 出力(Reply): 言語野が発話を生成（共有言語機能）
  - 出力(Memory): 内省を生成し LanceDB へ書き込み
```

入力層がこのアーキテクチャの起点。ジャッジ以降のどのロールも、入力層が作った同一の `TurnContext` を参照する（事実の一元化）。

```mermaid
flowchart TD
    Input["入力層: プリプロセス<br/>(センサー/記憶/作業記憶 → TurnContext)"] --> Judge["判断層: ジャッジ<br/>(カテゴリ + intent + REPLY + NEXT_STATE)"]
    Judge --> Action["行動・出力層: サブエージェント"]
    Action --> Reply["出力(Reply): 言語野 → 発話"]
    Action --> Memory["出力(Memory): 内省 → LanceDB"]
```

### B. アクション意思決定の深さ（行動・出力層の内部 = 2段）

行動・出力層の中の **アクション部分**だけを見ると、意思決定は2段。

```
ジャッジ（段1）: カテゴリ none | memory | research | express を選ぶ
    ↓
カテゴリサブエージェント（段2）: ツールカタログから具体ツール+引数を選ぶ
    ↓
実行: in-process（記憶）または MCP（探索・発信）
```

「2段ディスパッチ」は B の話、「3層アーキテクチャ」は A の話。これらは矛盾せず、A の行動・出力層の内側に B が収まる。

## 記憶サブエージェントのツール

| tool | 説明 |
|------|------|
| `remember` | LanceDB にファクト追記 |
| `recall` | LanceDB から意識的に掘り出す |
| `forget` | LanceDB からソフト削除 |
| `memo_write` | `data/notes/` に書く |
| `memo_read` | `data/notes/` を読む（冒頭抜粋インデックスで pick） |
| `distill` | 意味記憶蒸留（スタブ・未実装） |

### 記憶 vs メモの鮮明さ

| | エピソード記憶（LanceDB） | 共有メモ（ファイル） |
|--|---------------------------|----------------------|
| 性格 | 会話のふんわりした想起 | 意図して残した全文 |
| LLM | 想起・`recall` で要約・圧縮してよい | **既存本文の要約・改変はしない** |
| 重さ | 距離・提示濃さでぼかす | ファイルはそのまま全部渡す |

## 探索・発信（MCP）

- 設定: [config/mcp.json](../config/mcp.json)
- クライアント: `src/mcp/client.ts`（`@modelcontextprotocol/sdk`）
- MCP サーバ未接続時: `FakeMcpToolProvider` のスタブツール（`web_search`, `browse_url`, `calendar_read`, `post_tweet`, `calendar_write`）
- 発信: `expressDryRun`（既定 `true`）。`EXPRESS_DRY_RUN=false` で実投稿

### 発信と言語機能

発信サブエージェントは共有 **言語機能**（`src/roles/language-faculty.ts`）で文面を生成し、同一ターンで投稿する。ユーザー向け言語野と persona を共有し、声の分裂を防ぐ。

## ActionFacts

記憶系は従来どおり typed facts。探索・発信は汎用 facts:

```typescript
{ kind: "research" | "express"; tool: string; title: string; body: string }
```

## ターンの流れ

認知の3層（上記レイヤモデル A）を1行で表すと:

```
[入力] プリプロセス → [判断] ジャッジ → [行動/出力] サブエージェント → 言語野 → 内省 → LanceDB
```

`recall` 行動成功時は `recallDelivery: omit`（`facts.kind === "recall"` で判定）。

## 複雑化の吸収（反ネスト原則）

優先順: 複合ツール → サブエージェント内多段ループ（最大5ステップ）→ カテゴリ分割 → （最終手段）ネスト
