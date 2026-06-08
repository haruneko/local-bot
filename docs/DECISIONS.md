# 技術・設計決定ログ

CONCEPT.md の思想は変えず、実装判断だけをここに固定する。

## ランタイム

| 項目 | 決定 |
|------|------|
| 言語 | **TypeScript** (Node 20+) |
| パッケージ管理 | npm |
| テスト | Vitest（ユニット中心、LLM 統合テストなし） |
| LLM 主 | Ollama `@ http://192.168.16.1:11434`（`OLLAMA_HOST` で上書き） |
| チャットモデル | `qwen3.6:35b-a3b` |
| 埋め込み | `nomic-embed-text:latest`（`/api/embed`） |
| クラウド逃げ | `LlmClient` アダプタ差し替え。structured output 非対応時はプロンプト+パース+1リトライ |
| Ollama think | `config/settings.json` の `ollamaThink`（既定 `false`）。`OLLAMA_THINK` 環境変数で上書き可 |

## エージェント出力

各エージェントは 1 コールで「やらない」か「やる内容」かを決める（β方式。活性化チェックと実行を分けない）。

- **actor pool の各 actor**: Ollama `format`（JSON Schema）で `{ activate: false }` または `{ activate: true, tool: "...", intent: "..." }` を出力。`activate: true` のとき即実行。パース失敗・リトライ失敗 → `{ activate: false }` にフォールバック。
- **activator**: `{ "active": ["recall", "web-search", ...] }` を出力。LLM は actor 名のリストのみ返す。
- **language-agent**: `{ speech: "...", nextState: "..." }` を出力。`speech` が空文字のとき発話なし。`nextState` バリデーションなし（未知値はログのみ）。
- 活性化判断は必ず LLM で行う。ヒューリスティックによるスキップはしない。

## 内省くんの入力（CONCEPT からの拡張）

- 各エージェントの判断プロセス・ツール実行ログは渡さない
- **直近の会話**（作業記憶チャンネル）+ **いま自分が言ったこと** + **行動の結果サマリ**（該当時のみ）を渡す
- `ctx.actions` が空 → 行動セクション省略
- それ以外 → 各エージェントの「やろうとしたこと」「できた / できなかった」を自然言語で渡す（ツール名・スタックトレース・LLM 生応答は不可）
- `ctx.speech` が空 → 発話は `（返答はしなかった）`（一人称なし）

## レイヤモデル（用語固定）

- **認知の構造（2フェーズ）**: 入力（プリプロセス）→ 自律エージェント（activator → actor pool → language-agent → 内省/Memory）。プリプロセスが起点で、各 actor は宣言チャンネルの TurnContext を参照する
- 詳細は [ACTION-DESIGN.md](./ACTION-DESIGN.md)

## エージェント設計（v0.6）

- ジャッジは廃止。3 エージェント（memory / research / language）が直列に実行する
- 各エージェントは 1 コールで自己活性化判断 + 実行を行う
- `ctx.action: ActionOutcome` → `ctx.actions: ActionOutcome[]`（複数エージェントが順に積む）
- **memory-agent** (`src/agents/memory.ts`): 記憶ツールを選び LLM + in-process 実行
  - ツール: `remember`, `recall`, `forget`, `memo_write`, `memo_read`, `distill`（スタブ）
  - `forget`: LanceDB ソフト削除（`deleted` 列）。物理削除しない
- **research-agent** (`src/agents/research.ts`): MCP 読取系ツールを実行（`config/mcp.json`）。未接続時は Fake スタブ
- **language-agent** (`src/roles/language.ts`): 全 facts を受け取り発話生成 + NEXT_STATE 決定
- express エージェントは将来実装。`expressDryRun` 設定は維持
- メモ I/O は in-process。探索・発信は MCP アダプタ経由

## エージェント設計（v0.7）

memory-agent / research-agent の束ねを廃止し、全ツールをフラットな **actor pool** に配置する。v0.6 の「ジャッジ廃止」から一歩進め、エージェント内部の「束ね」も除去する。新しい actor を追加するとき「どこに挿入するか」を考えなくてよい。

- **actor pool**: `recall` `remember` `forget` `memo_write` `memo_read` `web-search` `url-browse` `webcam` など各ツールが独立 actor として並列に自律実行し `ctx.actions` に積む
- **activator（activation screener）**: actor pool の前に 1 コールで起動すべき actor を選定する小型スクリーナー。`roles.activationScreener` で設定
  - 入力: mini-context（直近 2〜3 ターン + 最新発話 + 内心ステート + 利用可能 actor リスト）。想起済みエピソードは渡さない
  - 出力: `{"active": ["recall", "web-search"]}`
  - false negative（必要な actor を外す）のコストが高いため、迷ったら ON のプロンプトにする
- **actor gating 2層**: activator が走る前に pool を絞る
  - Layer 1: `config/settings.json` の `actors[name].enabled`（全 State 共通）
  - Layer 2: `stateConfig[State].actors`（State 別有効 actor リスト）
  - 無効 actor は pool に入らず activator にも提示されない

## 記憶とメモの扱い（一貫性）

**二系統で保存の「鮮明さ」が違う。**

| 系統 | 保存先 | 読み出し時の方針 | 体感 |
|------|--------|------------------|------|
| エピソード記憶 | LanceDB | LLM 要約・グラデーション（full / summarize / vague）OK | ふんわり思い出す |
| 共有メモ | `data/notes/*.md` | **既存本文を LLM で要約・改変しない**。全文を `facts.body` に載せる | 重いが全部覚えている |

- メモで LLM が触るのは **新規作成**（`memo_write` の本文生成）と **どのファイルか選ぶ**（`memo_read` の pick）だけ
- エピソード側（自動想起・`recall` 行動・トークン超過時のチャンネル要約）は LLM 圧縮を許容する
- 言語野がメモ全文をそのまま読み上げないのは口調・長さの問題であり、メモ保存内容をいじることとは別

## 記憶

- エピソード: LanceDB（ローカルパス `data/lancedb/`）
- 想起: 直近ユーザー発話で embed → top-k（設定可能）
- `tags`: MVP は `[]`
- `participants`: ターンの話者 ID

## CLI

- 対話型 REPL（ストリーミングは Phase 1.5）
- `/heartbeat`, `/state <値>` 手動コマンド
- `--user <id>` で話者指定
- `--verbose` / `-v` でターン各段階・LLM 入出力を stderr に詳細ログ

## MVP 完了定義

CLI で数ターン会話し、内省が LanceDB に蓄積され、次ターンのコンテキストに想起されること。

## 内心ステートと recency 想起抑制

**採用**: 内省の直後に内心ステート（`innerState`）を更新し、`data/state.json` に持ち越す。言語野には `## いまの内心` として渡す（非空時のみ）。エピソード想起は直近 `recencyExclusionTurns` ターンの turnId を `excludeTurnIds` で除外し、作業記憶と時間軸を分ける。

**経緯**: 直前ターンの内省がベクトル想起で毎ターン再注入され、感情が過去化せずエコーチェンバーになる問題があった。感情の余韻は内心ステートが担い、想起はもっと過去の再構成に限定する。

**却下**:
- abstract mood scalar（感情を数値・ラベルに蒸留して言語野へ渡す）— 状況を失い、言語野が適切な文を吐けなくなる
- ターン数 binary cut（直近内省を想起から完全除外のみ）— 内省でしか起きなかった感情が N+1 で消える
- 強度タグ＋数値減衰曲線 — 忘却を外部パラメータで制御し、内省による創発と矛盾する

忘却は内省の書き換えと2〜3文の容量制約に委ねる。初期内心は空（起きたては内心なし）。

## ターンコンテキスト（1ターン限りの引き回し）

- 1ターンにつき **1つの `TurnContext`** を作成し、preprocess → activator → actor pool → language-agent → 内省の各段階で **同じオブジェクトを更新**する
- ターン終了時に破棄する（永続化は内省→LanceDB のみ）
- 各 actor は宣言した**知覚チャンネル**の TurnContext フィールドのみを参照する（詳細は §知覚チャンネル）。language-agent は全チャンネルを受け取る
- アドホックな TurnContext トリムは禁止。知覚チャンネル宣言による設計上の分離のみ許容（旧 `TurnBrief` / `VolatileContext` 二重経路の禁止は維持）
- 全エージェントは `memorySnapshot(ctx)` から同じ事実フィールドを参照する（language-agent は全フィールド）
- 内省は各エージェントの判断プロセスを参照せず `ctx.reply` + `ctx.speech` + `ctx.actions` のみ
- 行動成功時の構造化事実は `ActionFacts`（`action/facts.ts`）。表示は `action/present.ts`
- 作業記憶のボット発話ラベルは固定の「自分」（`BOT_SPEAKER_LABEL`）。一人称の口調は `persona/character.md` のみ
- `ctx.actions: ActionOutcome[]`（actor pool の結果を順不同で追加）

### 知覚チャンネル

各 actor は自分が必要とするチャンネルを宣言する。これはアドホックなトリム禁止（旧 TurnBrief / VolatileContext 問題）とは別物—論理的不要性・モダリティ差による設計上の分離。

**強制制約: activator と actor の知覚チャンネルを揃える**
activator が判断に使うコンテキストと、各 actor が判断に使うコンテキストのズレを最小にする。activator が軽いコンテキストで判断するなら actor も同じ軽さで判断しなければならない。知識の豊かさによる判断差（activator は「わからない」が actor は「もう十分ある」と知っている、等）は設計上の矛盾であり禁止する。この制約により activator と actors は同一モデル（`actionModel`）で動かせる。

| actor | channels |
|-------|----------|
| activator | conversation, inner_state, actor_list |
| 全実行 actors（recall / remember / memo_write / memo_read / web-search / url-browse / webcam / ...） | conversation, inner_state |
| webcam-actor のみ追加 | + image_feed |
| language-agent | 全チャンネル + ctx.actions |

- 知識チャンネル（`recalledEpisodes` / `semanticFacts` / `recalledNotes`）は language-agent のみが受け取る。actors には渡さない
- activator は actor_list も受け取る（どの actor が利用可能かを知る必要があるため）
- 将来 actor を追加するときは channels を明示して宣言する

### 想起の渡し方

`recallDelivery`: `omit` | `full` | `summarize` をターン内で明示する。

| 値 | 意味 |
|----|------|
| `full` | 想起エピソード全文を背景として渡す（既定） |
| `summarize` | preprocess で要約された想起を渡す |
| `omit` | 背景想起を渡さない（`recall` 行動成功時など、行動結果と重複する場合） |

コンテキスト組み立て時に、理由なく短く切り詰めて渡す暗黙トリムは使わない（表示用 preview や verbose ログの truncate は別）。

### 想起グラデーションフィルター

LanceDB ベクトル検索の直後、2段階で処理する（`src/recall/distance.ts` + `src/recall/llm-present.ts`）。

1. **距離分類**（機械）: L2 距離と閾値で presentation を決める
2. **LLM 提示**（エピソードのみ）: `summarize` / `vague` の本文を、いまの作業状況（state・きっかけ・想起クエリ）に照らして生成。無関係なら `presented: ""` で載せない

| presentation | 意味 | 分類 | 提示文 |
|--------------|------|------|--------|
| `full` | 直接関係が強い | 距離 ≤ `fullMax`（0.55） | 原文そのまま |
| `summarize` | 間接的に関係 | `fullMax` < 距離 ≤ `summarizeMax`（0.72） | LLM 要点（状況と無関係なら省略） |
| `vague` | かすかに染みる | `summarizeMax` < 距離 ≤ `vagueMax`（0.85） | LLM 感情のノリのみ（無関係なら省略） |
| `omit` | ほぼ無関係 | 距離 > `vagueMax` | 載せない |

`recall` 行動のヒット要約も LLM（`summarizeRecallActionHits`）。パース失敗時のみ機械フォールバック。

`TurnContext.recalledEpisodes` は `{ presented, relevance, presentation }[]` として保持し、全ロールが同じフィルター結果を参照する。

距離閾値はチューニング対象（`DEFAULT_RECALL_DISTANCE_THRESHOLDS`）。

## ハートビート時のゲート（SPEC 拡張）

- `shouldRunLanguage` は廃止。language-agent は常に起動し発話するかを内部で判断する
- `shouldPersistIntrospection(ctx)`: user_message は常に。heartbeat はトリガーが `heartbeat` かつ `ctx.actions` が空 かつ `ctx.speech` が空のとき（idle heartbeat）のみスキップ
- idle heartbeat は内省 LLM と LanceDB 追記をスキップ

## メモインデックスの設計

### 永続層の4層構造

記憶は目的と性質で4層に分離する。混ぜない。

| 層 | 保存先 | 目的 | 性質 |
|----|--------|------|------|
| エピソード記憶 | LanceDB `episodes` | 体験・感情の再構成（内省が書く） | ふんわり・減衰してよい |
| 意味記憶 | LanceDB `semantic` | 蒸留された知識・理解 | 凝縮・長持ち |
| メモインデックス | LanceDB `memo_index` | 「どこに何を書いたか」の所在管理 | 正確・機械的・減衰しない |
| メモ本文 | `data/notes/**/*.md` | 参照元の全文（不変） | ファイルシステム |

### `memo_write` のエピソード記録はしない

`memo_write` 成功時に `episodes` へ直接追記しない。

**理由**: 「どこに書いたか」は**情報源記憶（ソース記憶）**であり、エピソード記憶（体験・感情文脈）でも意味記憶（蒸留知識）でもない。`episodes` に押し込むのはカテゴリ違反で、二経路問題（内省との重複書き込み）も生じる。`remember` ツールは「LanceDB への書き込みそのものが行動目的」であり別物。

**正しい記録先**: `memo_index` テーブル（機械的・LLM 不要）。

### `memo_index` の構造

```
path:          "SoundHorizon/lyrics/elysion/A.md"   フルパス
path_segments: ["SoundHorizon", "lyrics", "elysion"] 階層フィルタ用
depth_1〜3:    各階層名                               構造クエリ用
preview:       冒頭200文字（機械的切り出し）           LLM加工しない
vector:        embed(path + preview)                 意味検索用
created_at:    ISO8601
```

- `preview` は機械的切り出しのみ。DECISIONS §記憶とメモの扱い の「既存本文を LLM で要約・改変しない」に準ずる
- `path_segments` で構造フィルタ（例: depth_1 = "SoundHorizon"）とベクトル検索を同時に使える
- `data/notes/` をそのまま Obsidian Vault として開けるようにファイル構造を保つ

### ファイルシステムと Obsidian 互換性

`data/notes/` はサブディレクトリ対応の階層構造とする。  
Obsidian でフォルダを Vault として開くだけでグラフビュー・全文検索・バックリンクが使える（追加実装ゼロ）。  
エージェント側は `memo_index` で索引を持ち、Obsidian はヒューマンリーダブルなビューとして使い分ける。

---

## stateConfig（State 別コンテキスト設定）

`config/settings.json` の `stateConfig` ブロックで State ごとに `workingMemoryTurns` / `episodeRecallTopK` を上書きできる。

```json
"stateConfig": {
  "対話": { "workingMemoryTurns": 20, "episodeRecallTopK": 3, "actors": ["recall", "remember", "memo_write", "memo_read", "web-search", "url-browse"] },
  "静穏": { "workingMemoryTurns": 5,  "episodeRecallTopK": 1, "actors": ["recall", "remember"] }
}
```

- フィルタは TurnContext に載せる量を絞るだけ。LanceDB・state.json の元データは変更しない
- キーが存在しない State は既定値（`workingMemoryTurns` / `episodeRecallTopK`）を使用

## ロール別モデル設定

`config/settings.json` の `roles` ブロックでロールごとにモデル名と thinking の on/off を指定できる。

```json
"actionModel": "qwen3-vl:8b-instruct",
"roles": {
  "language":      { "model": "qwen3.6:35b-a3b", "think": false },
  "introspection": { "model": "qwen3.6:35b-a3b", "think": false },
  "innerState":    { "model": "qwen3.6:35b-a3b", "think": false }
}
```

- `actionModel`: activator と全実行 actors が使うモデル。知覚チャンネルを揃えているため同一モデルで動かせる
- `roles` への個別指定で actor 単位の上書きは可能だが、知覚チャンネル制約を崩さない範囲に限る
- 未指定ロールは `chatModel` と `ollamaThink` のグローバル値を使用
- `OLLAMA_THINK` 環境変数より `roles[*].think` 指定が優先

---

## 禁止事項

- キーワードマッチでの直行ルーティング
- actor の知覚チャンネル宣言を無視したアドホックな TurnContext トリム（チャンネル宣言による設計上の分離は許容）
- ヒューリスティックによるエージェントのスキップ（活性化判断は必ず LLM で行う）
- `memo_write` 成功時に `episodes` へ直接追記すること（上記 §メモインデックスの設計 参照）
- フィルタ・コンテキスト縮小を理由に元データ（LanceDB・state.json）を削除・変更すること
