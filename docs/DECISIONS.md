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

- **各 actor の `activate()`**: Ollama `format`（JSON Schema）で `{ active: false }` または `{ active: true, intent: "..." }` を出力。各 actor が自分の判断で起動するかを決める。パース失敗・リトライ失敗 → `null`（起動しない）にフォールバック。
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

- **actor pool**: `recall` `remember` `forget` `memoWrite` `memoRead` `webSearch` `urlBrowse` `webcam` など各ツールが独立 actor として並列に自律実行し `ctx.actions` に積む
- **各 actor の `activate()`**: actor pool の前に各 actor が自身の起動を判断する（`src/actors/activate.ts` の `createActivate` ファクトリで生成）
  - 入力: mini-context（直近 `ACTOR_CONTEXT_TURNS=3` ターン + 最新発話 + 内心ステート）。想起済みエピソードは渡さない
  - 出力: `{ active: true, intent: "..." }` または `{ active: false }`
  - false negative（必要な actor を外す）のコストが高いため、迷ったら ON のプロンプトにする
  - activator と actor run は同一モデル（`actionModel`）・同一チャンネルで動かす（知覚チャンネル制約）
- **actor gating 2層**: `activate()` が走る前に pool を絞る
  - Layer 1: `config/settings.json` の `actors[name].enabled`（全 State 共通）
  - Layer 2: `stateConfig[State].actors`（State 別有効 actor リスト）
  - 無効 actor は pool に入らず `activate()` も呼ばれない

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

## affect/concern 分離設計

**動機**: `innerState`（感情余韻）だけでは「今何に注目しているか」という認知的焦点を次のターンに引き継げない。heartbeat が idle になりやすく、連続行動が成立しない（ROADMAP §自律動作の既知問題A 参照）。

**設計**:

- `innerState` を `affect`（感情余韻）に名前変更する（破壊的変更）
- `concern`（関心事・認知的焦点）を新規フィールドとして `data/state.json` に追加する
- 1回の LLM 呼び出しで `{affect: string, concern: string}` を返す（`updateAffectAndConcern`）
- 入力: 前回 affect（1文に圧縮）、前回 concern（1文）、内省本文、発話、行動結果
- `concern` を actor activate の inner_state チャンネルに含める（webSearch など具体的な行動指向のため）
- `buildRecallQuery` の heartbeat 優先順: `concern → affect → null`（関心事がより具体的なクエリになる）
- LLM が毎ターン concern を更新するかどうか自律的に判断する。更新しなくてよいなら前回と同じ内容を返せばよい

**構造ドリブン**: 前回 concern を入力として渡すことで、「同じことを書き続けている＝行き詰まり」を LLM が自然に認識できる。プロンプト上の明示的な指示は不要（構造が行き詰まり認識を可能にする）。

**単一 LLM 呼び出しの理由**: affect と concern は同じターンの出来事を素材に書かれる。先に内省を書かせ、その出力を受けて affect+concern を1回で更新する。分離した2コールは不要（内容が独立していない）。

**却下**:
- agenda フィールド: 「やること」の列挙は「予測ゲートの罠」に入りやすい。concern は「何に注目しているか」という現在の認知状態であり、タスクリストではない
- プロンプトに行き詰まり判定指示を書く: 指示ではなく構造（前回 concern の入力）で解決する

## 内心ステートと recency 想起抑制

**採用**: 内省の直後に affect（旧 `innerState`）と concern を更新し、`data/state.json` に持ち越す。言語野には `## いまの内心` として affect を渡す（非空時のみ）。エピソード想起は直近 `recencyExclusionTurns` ターンの turnId を `excludeTurnIds` で除外し、作業記憶と時間軸を分ける。

**内心の焼き直し防止**: `updateAffectAndConcern` に渡す `prevAffect` は最初の1文（句点区切り）に切り詰める。フル文を渡すと変化が小さいターンで前の内心の言い換えになりがちなため。内心更新プロンプトは「このターンの出来事を主な根拠に書く、前の内心は参照程度」とする。

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
| `full` | 直接関係が強い | 距離 ≤ `fullMax`（既定 0.55） | 原文そのまま |
| `summarize` | 間接的に関係 | `fullMax` < 距離 ≤ `summarizeMax`（0.72） | LLM 要点（状況と無関係なら省略） |
| `vague` | かすかに染みる | `summarizeMax` < 距離 ≤ `vagueMax`（0.85） | 機械的固定フレーズ `（おぼろげな感触だけが残っている）`（LLM 不使用） |
| `omit` | ほぼ無関係 | 距離 > `vagueMax` | 載せない |

`recall` 行動のヒット要約も LLM（`summarizeRecallActionHits`）。パース失敗時のみ機械フォールバック。

`TurnContext.recalledEpisodes` は `{ presented, relevance, presentation }[]` として保持し、全ロールが同じフィルター結果を参照する。

**relevance スコアの計算式**（`src/recall/distance.ts`）:

```
relevance = distanceToRelevance(distance) × recencyDecay(timestamp) × (importance / 10) × inhibitionPenalty
```

- `distanceToRelevance`: `1 - distance / vagueMax`（距離が近いほど高い）
- `recencyDecay`: 半減期 ~70日の指数減衰（`exp(-0.01 × 経過日数)`）
- `importance / 10`: エピソードの重要度スコア 1-10 を 0.1-1.0 に正規化
- `inhibitionPenalty`: `max(0, 1 - 0.7 × 抑制バッファとの最大コサイン類似度)`。直近ターンで想起済みの類似ベクトルを抑制する

距離閾値はチューニング対象（`DEFAULT_RECALL_DISTANCE_THRESHOLDS`）。

## 想起クエリの優先順（`buildRecallQuery`）

プリプロセス時のベクトル検索クエリは以下の優先順で決まる。

| トリガー | 優先順 |
|----------|--------|
| `user_message` | 直近ユーザー発話（なければ `"."` ） |
| `heartbeat` | 直近ユーザー発話 → 前回発話（`lastAssistantContent`、独り言含む） → `concern`（認知的焦点） → `affect`（ムードベース） → **null（recall スキップ）** |

- heartbeat かつ何も種がない（= 会話も発話も concern も affect も空）場合は `null` を返し、recall・semantic・memoIndex の検索を全スキップする
- 前回発話を種にする理由: 「次は〇〇を調べよう」という独り言が次のハートビートの検索クエリになり、タスク継続性が生まれる
- `concern` を `affect` より上位に置く理由: 認知的焦点は「何について調べているか」という具体的なクエリになりやすい。`affect`（感情）は「今の気分に合った記憶」を引くが継続性に弱い
- `"heartbeat 静穏"` などの固定文字列フォールバックは廃止（同じクエリ → 同じ結果 → ノイズ）

## ハートビート時のゲート（SPEC 拡張）

- `shouldRunLanguage` は廃止。language-agent は常に起動し発話するかを内部で判断する
- `shouldPersistIntrospection(ctx)`: user_message は常に。heartbeat は **succeeded なアクションが0件** かつ `ctx.speech` が空のとき（idle heartbeat）のみスキップ。アクターが走ったが全部失敗した場合もスキップ対象
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
  "対話": { "workingMemoryTurns": 8, "episodeRecallTopK": 6, "actors": ["recall", "remember", "memoWrite", "memoRead", "webSearch", "urlBrowse"] },
  "静穏": { "workingMemoryTurns": 5, "episodeRecallTopK": 2, "actors": ["recall", "remember", "memoWrite", "memoRead", "webSearch", "urlBrowse"] }
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
  "affect":        { "model": "qwen3.6:35b-a3b", "think": false }
}
```

`roles` のキーは `language` / `introspection` / `affect` の3つのみ。旧 `innerState` キーは `affect` に名前変更。v0.6 時代の `memory` / `research` キーは廃止。

- `actionModel`: activator と全実行 actors が使うモデル。知覚チャンネルを揃えているため同一モデルで動かせる
- `roles` への個別指定で actor 単位の上書きは可能だが、知覚チャンネル制約を崩さない範囲に限る
- 未指定ロールは `chatModel` と `ollamaThink` のグローバル値を使用
- `OLLAMA_THINK` 環境変数より `roles[*].think` 指定が優先

---

## webSearch 自発起動（内心ドリブン）

**動機**: ユーザーから「好きなものを調べてて」と許可された後、ボットが独り言で「調べよう」と意志を表明しても webSearch が起動しないバグ。activator の description が「直近の会話に検索意図があるか」という一方向の判断しか持たず、自分の意図（独り言・innerState）を行動トリガーとして読まなかった。

**設計**:

- webSearch の起動判定を2段階で行う。
  1. **指示ベース（優先）**: 直近の会話にユーザーの明示的な検索依頼がある → 活性化
  2. **内心ベース（フォールバック）**: ユーザー指示がない場合、innerState または直近独り言に具体的な調査意欲がある → 活性化
- 判断コンテキストに `inner_state` チャンネルを追加する（DECISIONS §知覚チャンネルの整合性要件に従い activate / run で共通）。なお `DEFAULT_ACTOR_CHANNELS` には元から `inner_state` が含まれていたが、`config/settings.json` の上書き `channels: ["conversation"]` で打ち消されていた。上書きを削除し DEFAULT に戻す。
- `createActivate` にオプショナルな `systemPrompt` を追加し、webSearch はカスタムプロンプトで2段階ロジックを記述する。

**内心チェックのコンテキスト範囲**: innerState（毎ターン内省くんが書き換え・進捗を蓄積）+ 直近3ターン（conversation チャンネル、独り言含む）。古い独り言は innerState に凝縮されるため monologue を深追いしない。

**却下**:
- 別 actor に分ける案: 排他制御が複雑になる。同一 actor で2段階判断するほうがシンプル
- monologue 専用チャンネル化: conversation チャンネルに既に含まれている

---

## ハートビート言語野のフォーマット統一（実装済み）

**動機**: heartbeat の language-agent が全コンテキストを1つの user message に詰め込むフラット形式（`renderLanguageUserContent`）を使っていた。user_message は multi-turn messages 形式で渡すのに、heartbeat だけ異なる経路だった。コンテキストが長くなると直近の独り言が埋もれ、「次の一手」がモデルに届かない問題があった（ROADMAP §自律動作の既知問題 D 参照）。

**設計**:

- `generateDialogueSpeech` のハートビート専用分岐を削除し、両トリガーとも `buildLanguageDialogueMessages` を経由させる
- `buildConversationTurns` に `opts?: { includeMonologue?: boolean }` を追加。heartbeat は `includeMonologue: true` で渡し、直前ターンの独り言が `role: "assistant"` として multi-turn に入る
- 状況行は heartbeat のとき `ハートビート` と表示（speaker 名なし）
- temperature は両トリガーで 0.8 に統一（旧 heartbeat は 0.6）
- `resolveNumPredict`（research 結果あり時に numPredict 無制限にする）を heartbeat にも適用

**独り言が届く条件**: `priorTurns` に user ターンが1件以上ある場合のみ。「先頭の孤立 assistant はスキップ」規則により、user ターンがない純 heartbeat シーケンスでは先行の独り言は multi-turn に入らない（innerState で代替）。

**LANGUAGE_HEARTBEAT_SYSTEM_PREFIX の変更**: `入力の読み方` の「未完了の依頼」セクション参照を「会話履歴の最後のユーザー発話」に言い換え。フラット形式に依存したセクション名への言及を排除。

**却下**:
- 旧フラット形式の維持: heartbeat の独り言が埋もれる問題が解消できない
- heartbeat に multi-turn を使わず独り言を system suffix に移す案: system suffix は静的コンテキスト向きであり、時系列のある独り言には不適

---

---

## 禁止事項

- キーワードマッチでの直行ルーティング
- actor の知覚チャンネル宣言を無視したアドホックな TurnContext トリム（チャンネル宣言による設計上の分離は許容）
- ヒューリスティックによるエージェントのスキップ（活性化判断は必ず LLM で行う）
- `memo_write` 成功時に `episodes` へ直接追記すること（上記 §メモインデックスの設計 参照）
- フィルタ・コンテキスト縮小を理由に元データ（LanceDB・state.json）を削除・変更すること
