# 技術・設計決定ログ

CONCEPT.md の思想は変えず、実装判断だけをここに固定する。これは**ログ**なので、過去の決定（後に置き換わったものを含む）が時系列で積まれている。

> **現状サマリ（2026-06・古い決定エントリより優先）**
> - actor pool＝`memory / memo / webSearch / urlBrowse / (webcam未) / plan / synthesize`。記憶系は性質で2 faculty: **`memory`＝受動の記憶**（recall+forget 統合・op で 想起/忘却 を選ぶ・Read+Delete のみ）／**`memo`＝能動の記録**（notes の full CRUD）。**ジャッジ・カテゴリサブエージェント・memory-agent/research-agent・記憶統括は廃止/却下**（B'＝§記憶系アクターの分割統治）。
> - **`remember` 廃止**：意図的な内部記憶は「書き込み」でなく importance 採点（気にかけ度・**内心更新 affect と同じ呼び出しで採点**＝§内省の見える範囲）で扱う。`EpisodeSource "remember"` は履歴用に温存。
> - **`memoWrite`/`memoRead` を統合 `memo` actor に置換**：op（view/create/append/replace/section_replace）＋純関数 applier＋MOC ツリー＋連想ディセント＋recall フォールバック＋サイズ自動分割（[MEMO-TREE.md](MEMO-TREE.md)）。
> - 以下の各エントリ内の `remember`/`memoWrite`/`memoRead`/ジャッジ/memory-agent 等への言及は、上記より前の文脈。現状は本サマリ＋ACTION-DESIGN.md/SPEC.md を正とする。

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

## エージェント設計（v0.6・歴史的記録）

> 現行は下記 **v0.7 actor pool**。本節のパス（`src/agents/*.ts` 等）は当時のもので現存しない。経緯として残す。

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
  - **同一チャンネル**で動かす（知覚チャンネル制約）。モデルは `activatorModel`（起動判断）と `actionModel`/`actors[name].model`（実行）に分離可能。起動判断は軽い判断なので、実行用の重いモデルと別に小型・高速モデルを充てられる（制約はチャンネル一致であってモデル一致ではない）
- **actor gating 2層**: `activate()` が走る前に pool を絞る
  - Layer 1: `config/settings.json` の `actors[name].enabled`（全 State 共通）
  - Layer 2: `stateConfig[State].actors`（State 別有効 actor リスト）
  - 無効 actor は pool に入らず `activate()` も呼ばれない

## 記憶とメモの扱い（一貫性）

**二系統で保存の「鮮明さ」が違う。**

| 系統 | 保存先 | 読み出し時の方針 | 体感 |
|------|--------|------------------|------|
| エピソード記憶 | LanceDB | LLM 要約・グラデーション（full / summarize / vague）OK | ふんわり思い出す |
| 共有メモ | `data/notes/*.md` | **本文を LLM で要約しない**（劣化させない）。構造保存的な op 編集は可 | 重いが全部覚えている |

- 禁止の本質は「LLM に本文を**要約させて記録を劣化させる**（情報喪失・捏造）」こと。**要約は引き続き禁止**。
- **構造保存的な op 編集は許可**（`create` / `append` / `replace`＝厳密置換 / `section_replace`＝見出し単位差し替え）。op は要約ではなく差分で、**対象を読み込み厳密一致を確認してから**適用するため劣化が起きない（read-before-edit を**コードで強制**）。
- メモで LLM が触るのは **op の選択**と **op が運ぶ差分の一文**だけ。`_index.md`（MOC）は機械生成物で LLM に書かせない。
- エピソード側（自動想起・`recall` 行動・トークン超過時のチャンネル要約）は LLM 圧縮を許容する
- 言語野がメモ全文をそのまま読み上げないのは口調・長さの問題であり、メモ保存内容をいじることとは別
- 設計詳細: [MEMO-TREE.md](MEMO-TREE.md)（locate=recall認識主＋連想ディセント・MOC ツリー・op 純関数 applier・行 op）

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
activate が判断に使うコンテキストと、各 actor が実行に使うコンテキストのズレを最小にする。activate が軽いコンテキストで判断するなら実行も同じ軽さで判断しなければならない。知識の豊かさによる判断差（activate は「わからない」が actor は「もう十分ある」と知っている、等）は設計上の矛盾であり禁止する。制約は**チャンネル一致**であってモデル一致ではない。起動判断は `activatorModel`、実行は `actionModel` と分離できる。

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

実効値は `config/settings.json` の `recallDistance`（コード既定 `DEFAULT_RECALL_DISTANCE_THRESHOLDS` を settings が上書き）。現状: `fullMax 0.45 / summarizeMax 0.72 / vagueMax 0.78`。

| presentation | 意味 | 分類 | 提示文 |
|--------------|------|------|--------|
| `full` | 直接関係が強い | 距離 ≤ `fullMax`（現状 0.45） | 原文そのまま |
| `summarize` | 間接的に関係 | `fullMax` < 距離 ≤ `summarizeMax`（0.72） | LLM 要点（状況と無関係なら省略） |
| `vague` | かすかに染みる | `summarizeMax` < 距離 ≤ `vagueMax`（現状 0.78） | 機械的固定フレーズ `（おぼろげな感触だけが残っている）`（LLM 不使用） |
| `omit` | ほぼ無関係 | 距離 > `vagueMax` | 載せない |

`recall` 行動のヒット要約も LLM（`summarizeRecallActionHits`）。パース失敗時のみ機械フォールバック。

`TurnContext.recalledEpisodes` は `{ presented, relevance, presentation }[]` として保持し、全ロールが同じフィルター結果を参照する。

**relevance スコアの計算式**（`src/recall/distance.ts`）:

```
relevance = distanceToRelevance(distance) × recencyDecay(timestamp) × (importance / 10) × inhibitionPenalty × speakerBoost
```

- `distanceToRelevance`: `1 - distance / vagueMax`（距離が近いほど高い）
- `recencyDecay`: 半減期 ~70日の指数減衰（`exp(-0.01 × 経過日数)`）
- `importance / 10`: エピソードの重要度スコア 1-10 を 0.1-1.0 に正規化
- `inhibitionPenalty`: `max(0, 1 - 0.7 × 抑制バッファとの最大コサイン類似度)`。直近ターンで想起済みの類似ベクトルを抑制する
- `speakerBoost`: いま話している相手が `participants` に含まれるエピソードを `SPEAKER_MATCH_BOOST`（×1.3）。話者一致の記憶を浮かせる。omit 判定（距離ゲーティング）は変えない

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

- `actionModel`: 全実行 actors の既定モデル。actor の起動判断は `activatorModel`（未設定なら `actionModel`）。起動判断は軽いので小型・高速モデルを充ててよい
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

**原則化（2026-06-14）**: 上記の「指示／計画／内心」3段階の列挙を、**単一の目的テスト**へ畳んだ。判定軸は「この問い／取り組みを前に進めるのに、会話の中には無い"外界の事実"（最新・固有・要検証）が要るか」の一点。トリガーが指示・計画・好奇心のどれかは問わない。理由: ①「〜は？」等のキーワード列挙が餌になり、「記憶にあるコード進行は？」のような**外界の事実を要さない問い**で誤発火していた（実機で確認）。②activator は recall の中身を見られない（並列・後段）ので「記憶にあるか」では判定できず、**問いの性質**で判断させるのが正しい。プロンプトから役割名 "webSearch" と「記憶を読めない」前提の説明も削り、純粋に「外を調べる必要があるか」だけを問う形にした。

---

## ハートビート言語野のフォーマット統一（実装済み）

**動機**: heartbeat の language-agent が全コンテキストを1つの user message に詰め込むフラット形式（`renderLanguageUserContent`）を使っていた。user_message は multi-turn messages 形式で渡すのに、heartbeat だけ異なる経路だった。コンテキストが長くなると直近の独り言が埋もれ、「次の一手」がモデルに届かない問題があった（ROADMAP §自律動作の既知問題 D 参照）。

**設計**:

- `generateDialogueSpeech` のハートビート専用分岐を削除し、両トリガーとも `buildLanguageDialogueMessages` を経由させる
- `buildConversationTurns` に `opts?: { includeMonologue?: boolean }` を追加。heartbeat は `includeMonologue: true` で渡し、直前ターンの独り言が `role: "assistant"` として multi-turn に入る
- 状況行は heartbeat のとき `ハートビート` と表示（speaker 名なし）
- temperature は両トリガーで 0.8 に統一（旧 heartbeat は 0.6）
- `resolveNumPredict`（research 結果あり時に numPredict 無制限にする）を heartbeat にも適用

**独り言が届く条件**: heartbeat（`includeMonologue: true`）では、user ターンが無い純 heartbeat 連続でも自分の独り言を `role: "assistant"` として落とさず渡す（静穏連続でも自己連続性を保つため）。「先頭の孤立 assistant をスキップ」規則は対話（`includeMonologue: false`）のみに適用する。Ollama は system→assistant 始まりの列を許容する。

**LANGUAGE_HEARTBEAT_SYSTEM_PREFIX の変更**: `入力の読み方` の「未完了の依頼」セクション参照を「会話履歴の最後のユーザー発話」に言い換え。フラット形式に依存したセクション名への言及を排除。

**却下**:
- 旧フラット形式の維持: heartbeat の独り言が埋もれる問題が解消できない
- heartbeat に multi-turn を使わず独り言を system suffix に移す案: system suffix は静的コンテキスト向きであり、時系列のある独り言には不適

---

---

## 話者対応（speaker-aware）

- `config/users.yaml` の各話者に任意 `note`（関係性の一文）。`createUserProfileResolver` で解決し、言語野の `## 相手について` に注入＝誰と話すかで反応が変わる（`src/roles/language-faculty.ts`）。heartbeat では注入しない
- 想起の話者バイアス: `EpisodeRecallHit.participants` を recall で載せ、`classifyRecallHits` で現在の話者一致を `SPEAKER_MATCH_BOOST`(×1.3) 重み付け（§想起グラデーション）。omit 判定は変えない
- `remember` は `participants:[speakerId]` を記録し、話者名をプロンプトに渡す（旧: `participants:[]`・「ユーザー」固定だった）

## 自他境界の扱い（ロール別に手段を分ける）

- **内省・内心**（`introspection.ts` / `inner-state.ts`）: 会話を role 構造（相手=`user` / 自分=`assistant`、独り言も assistant）で渡す（`buildReflectionMessages`）。旧フラット `renderIntrospectionPrompt` は廃止
- **remember / memoWrite**: フラット1メッセージ＋明示的な方向ラベル（「あなたに話しかけている相手: X（あなた自身ではない）」「X があなたに言ったこと: …」）。**role 構造化は試したが remember の JSON 出力が回帰した**ため採らない（35B が会話継続を吐く）

## メモ書き込みの既存本文保全

- **（v0.7 まで）** `memoWrite` は既存ファイルを**絶対に上書きしない**。同名ファイルがあれば `append` を強制（`runMemoWrite`）。推敲ができない制約があった。
- **（改訂・[MEMO-TREE.md](MEMO-TREE.md)）** op 編集（`replace`/`section_replace`）で部分修正を許可。ただし **read-before-edit ＋ 厳密一致確認**を**コードで強制**し、要約による劣化・盲目改変を構造的に排除する。全文の盲目上書きは引き続き不可（一致しない `replace` は失敗扱い）。
- ファイル名の日付ハルシネーション防止に `基準日時` をプロンプトに渡す

## ツール引数の検証と研究失敗判定

- 小型モデルがツール引数の形を誤る（`url:string` にオブジェクト等）ため、MCP 呼び出し前に `coerceToolArgs`（`src/action/coerce-args.ts`）でスキーマ照合・軽い型強制・必須チェック
- `isNetworkError` から `-32603`（JSON-RPC 汎用 Internal error）を除外（引数不正をネットワーク障害と誤判定してリトライを潰すのを止める）
- `runSubagentToolPick` のパース失敗を `actionSucceeded` でなく `actionFailed` で返す（偽成功の修正）
- **web 検索は Tavily API**（`scripts/mcp-research.mjs`）。Docker(searxng) は重く不安定だったので廃止。Tavily は LLM 向けで `answer`＋本文抜粋も返し、コード進行のような「中身が欲しい」用途に強い。キーは `.env` の `TAVILY_API_KEY`（MCP 子は親 env を継がないので mcp-research.mjs が `.env` を自読み）。`browse_url` は素の fetch のまま。searxng 関連（docker-compose / `searxng:*` スクリプト）は legacy

## ログ 3 段階

- `quiet`（発話＋state のみ）/ `info`（1ターン十数行の構造化サマリ・stderr）/ `debug`（旧 `--verbose`、全 LLM 入出力）。`src/util/verbose.ts`
- 既定: REPL=`quiet`、Slack/heartbeat=`info`。`-v`→debug、`-q`→quiet
- per-call の `llm.*` 行は info では出さない（フェーズ別 ms でレイテンシは追える）

## say CLI

- `npm run say -- "メッセージ"`: 1 ターンだけ `user_message` を送って終了（既定話者 `claude_kuro`＝開発補助 AI「クロ」）。`--memory-only` は state.json も使わない完全使い捨て

## 集中モード（focus State）/ 計画チャンネル / plan actor

長期計画に沿った自律稼働の v1。**計画を予測ディスパッチャにしない**のが核（`docs/archive/deliberation-plan-deprecated.md` §8 の暴走の教訓）。人間の「集中モード」＝Preprocess に目的が常駐し状況で actor をオンオフする、という着想を既存機構に乗せた。

**強制ギプス（構造はコード・中身は LLM）**: 生成的・連想的が得意な LLM に精密な文書操作をさせると壊れる（v1 マークダウン版で見出し重複・データ消失・未来文漏れが発生）。そこで**記録層は決定的な足場に載せ替える**——recall 側が「距離分類=機械＋LLM は意味だけ」なのと対称。人間も精密さは脳外の硬いツール（リスト・表）＋単純操作に逃がしている。対象は**エバ自身が保守する構造化記録**＝今は `plan` のみ（recall/remember/memoWrite 等は据え置き）。

- **真実の源 = 構造化state（JSON, `data/plans/<id>.json`）**。markdown はそこから決定的にレンダリングしたビュー（`src/plan/state.ts` `ops.ts` `render.ts`）。LLM は**文書も diff も書かず、op を1つ返すだけ**。
- **plan op**（flat schema）: `new_goal` / `complete` / `reopen` / `set_current` / `add_milestone` / `log` / `noop`。`applyPlanOp` が決定的に適用（milestone id 採番・current 前進・履歴追記は全部コード）。LLM が出すのは op の選択と短い一文（milestone text / log）と**見えている id の参照**だけ＝remember/affect と同じ粒度で小型モデルが安定して出せる。
- **新 State `集中`**: `KNOWN_STATES` に追加。`stateConfig["集中"]` で actor を絞る。
- **計画チャンネル**（Preprocess）: `data/state.json` の `focusPlan`（取り組み中 plan id）。`state==="集中"` のとき turn.ts が `loadPlan→renderPlan` を `ctx.plan` に載せ、言語野と plan チャンネル宣言 actor に `## 取り組み中の計画` として常駐注入。集中以外は空。`plan` actor は `ctx.planId`（=focusPlan）でその plan を更新する。
- **`plan` actor**（`src/actors/plan.ts` `src/roles/plan.ts`）: op を出す → `applyPlanOp` → `savePlan`（JSON）＋ `data/notes/goals/<id>.md` ミラーを決定的に上書き（派生ビューなので上書き可）＋ memo_index upsert。outcome `ActionFacts { kind:"plan", planId, filename, body }` を受けて orchestrator が `focusPlan` を差し替え。
- **集中の3段制御（2026-06-13 改訂。旧「plan op 成功で集中に強制上書き」は廃止）**:
  - **入口＝切り離し**: メモ感覚で plan を1つ作っただけで集中に固定される事故が出たため、plan 作成と集中入室を切り離した。`focusPlan` は **言語野が `nextState="集中"` を deliberate に選んだときだけ**確定する（`LANGUAGE_OUTPUT` に「計画やメモを作っただけでは集中にしない・相手が感情/別話題を向けたら対話優先」を明記）。plan の activate も「在庫・リスト・記録の*管理*は memo の領分・plan は段階を踏む目標のときだけ」に締めた。
  - **出口＝trigger 依存 sticky**: `focusPlan` が未達のあいだ集中を維持するが、**ハートビート（相手の居ない自律ターン）でだけ**効かせる。対話ターンでは効かせず言語野判断に任せる＝相手が感情・別話題を向けたら集中を抜けて向き合える（タスク固執＝「タコ耳」の解消）。`focusPlan` は達成まで残るので、会話を抜けた後のハートビートで goal に復帰。「喋る間は相手に・独りなら自分の作業に」。
  - **上限＝強制ギプス**: `state.json` の `focusStreak`（集中連続ターン数・ハートビート跨ぎで永続）が `MAX_FOCUS_STREAK`(=10) に達すると集中力が切れて `focusPlan` を手放す（goal ノートは残る）。ハートビートで「ずっと同じことを考え続ける」無限ループ（非人間的な強迫）を防ぐ＝人間の疲労の代替。
- **断片化防止**: op モデルでは継続は `complete`/`log`/`add_milestone` が `ctx.planId` の plan に適用される。新規 plan は `new_goal` を明示したときだけ（`PLAN_SYSTEM` で「計画があるとき new_goal は使わない」と指示）。v1 は**同時1ゴール**。plan は 対話/静穏/集中 すべてで有効（静穏からの再開のため）。
- **達成ライフサイクル**: 全マイルストーンが done になったら `applyPlanOp` 後に「達成」ログを1回足し、`facts.achieved=true`。orchestrator は **`focusPlan` をクリア**し集中入室を強制しない（言語野が次の State を選ぶ）。JSON/markdown は達成記録付きで残る。
- **効果ゼロ op は outcome にしない**: 適用前後で plan の中身が変わらなければ（存在しない id への complete 等）`runPlan` は `notAttempted` を返す（focusPlan 変更・集中入室を起こさない）。`noop` も同様。
- **結果グラウンディング（意図でなく結果を記録）**: plan actor は他 actor の**後に**実行し（`runActorPool` で plan を最後に回す）、`ctx.actions`（このターンの研究・記憶の成否）を `PLAN_SYSTEM` の入力に渡す。**実際に達成・取得できたことだけ complete/log する**。研究が失敗・未取得なら complete しない（noop か失敗を log）。これが無いと「調べようとした＝調べた」と意図で進捗が付き計画が現実から乖離する（実機で観測したバグ）。内省・内心が結果を見て事後に書くのと同じ原理を plan にも適用。

**予測ゲートの罠を踏まない不変条件**:
- plan が持つのは **目標・マイルストーンの状態・履歴**＝結果の外部化物。`PLAN_SYSTEM` で「次は〜する」等の未来の行動を log に書くことを禁止。op に「次の手順」を表す手段が無い（構造的に書けない）。
- 「次の一手」は毎ターン pool が計画チャンネルを文脈として読んで自分で決める（リストは地図でありプログラムカウンタではない）。
- 自他は memoWrite/remember 同様フラット＋方向ラベル。

**クロスターン連続実行（runUntilSettled）は今回も見送り**: 安全な停止条件（break）が要る。deprecated 版は「未回答＝open」で暴走した。正しい停止条件は「ACTION 失敗のみ open」だが、計画モードが安定して観察できるまで導入しない。計画チャンネル＋heartbeat の自然な継続（独り言→recall）で v1 は回す。

---

## 幻覚（作話）への構え（2026-06-14）

**観察**: 「記憶からおすすめのコード進行を」と頼まれた実機ターンで、エバが「何度となく聴いてきた曲のフレーズ」「クロが隣で寝ている」など**実態の無い一人称体験を事実として口走り**、しかもそれが内省経由で episode に焼かれて"自分史"化していた。カジュアルに、悪気なく幻覚る。

**構えの整理（なぜ起きるか）**: これは概ね**設計どおりの帰結**であって、止められる種類の話ではない。
1. 言語野・内省は[分離脳の左脳モデル](CONCEPT.md)に倣った**事後ナレーション＝作話器**。左脳インタープリタは原因にアクセスできないまま、つじつまの合う物語を自信満々に生成する（欠けを埋める）。具体のでっち上げはその器官の仕様。
2. ペルソナが招く: 「自宅で暮らす存在」と身体・生活を与えながら実際の感覚入力は無い → モデルは空白を「家にいる存在ならありそうな具体」で埋める。
3. **provenance（出どころ）タグが無い**: 本物の知覚（datetime＝実時刻に裏打ち）と生成した心象（クロが寝てる＝想像）が同じストリームに区別なく並ぶ → 内省がどちらも等しく「起きたこと」として記憶化＝**作話のロンダリング**。

**方針**: 作話器に「作話するな」は無理。代わりに **(a) 出どころを分ける** と **(b) 招きを断つ**。provenance を**複雑なタグ管理プロンプトで実装するのは小モデルには倒せない**ので、原則1個＋招きの除去で寄せる。
- **A. webSearch**: 「外界の事実が要るか」原則化（上記 §webSearch 自発起動）。記憶・内面の問いに外部検索を肩代わりさせない。
- **B. 空想起の正直化**: recall が空のとき「記憶を探したが、思い当たるものは無かった」を返し、language には「**覚えている（エピソード記憶）≠知っている（一般・意味知識）**」を分ける原則を1行。一般論を記憶や感覚のフリで差し出さない／一般知識なら「一般的には〜」と立場を分ける。
- **C. 招きの除去（禁止条項・身体否定は足さない）**: persona の自己モデルから「自宅で暮らす／日々を共に」を削除。独り言の良い例から身体 errand（「買い物に行こう」）を削除（差し替えると新しい轍になるので消すだけ）。**身体を否定しない**＝将来 embodied 化（センサ・固定設定で実態を持つ）したら自然に戻せる。実態があるなら持ってよい、妄想で遊ぶのは違う、という線。

### ②符号化側のロンダリング対策＝設計（2026-06-15・本丸・未実装）

**問題**: 内省は `ctx.speech`（作話を含みうる）と ActionFacts（実際の行動結果＝裏打ちあり）の両方を見ているのに、「発話より行動結果を信じよ」という重みが無い。すり抜けた作話が**内省本文＝エピソード本文**にそのまま焼かれ、想起で確信的な事実として戻り、夢で自分史化する。

**制約**: 出どころを**LLM が付けるタグで管理するのは小モデルには無理**（上の方針）。だから**コードで強制する**。

**設計の芯＝エピソードを「誰が書いたか」で2層に割る**:
- **事実の背骨（コードが機械生成・裏打ちあり）**: そのターンで実際に起きたこと＝どの actor が何をしたか（ActionFacts: research / memo / recall / synthesize 等の結果）＋実際の発話＋相手の発話。`present.ts`（`formatActionForIntrospection` 等）を流用。**LLM は1文字も書かない**ので作話が混入しない。これがエピソードの正本。
- **内省の上塗り（LLM＝内省・感じたことの層）**: 感じたこと・気づき・相手への気持ち・意味づけだけ。`INTROSPECTION_SYSTEM` に「行動・事実は事実欄が持つ。あなたは感じたこと・意味だけ書く。やってない行動（確認した／調べた）を事実として書かない」を入れ、役割を感情の層に限定する。

これで「冷蔵庫を確認した（作話）」は背骨に無く（ActionFacts に無いから）、上塗りは感じたことの層として扱われる＝**作話が事実欄に化ける主経路がコードで断たれる**。出どころは「LLM が申告するタグ」でなく「**誰が書いたか（コード＝裏打ち／LLM＝感じたこと）**」という構造で表れる＝小モデルにタグ管理させない。

**想起・夢への伝播**:
- 想起: 背骨＝事実として、上塗り＝「〜と感じた／思った」として提示（`llm-present.ts`）。recall した上塗りを行動の事実として再発話しない。ふんわり想起のグラデーションはそのまま。
- 夢（蒸留）: 背骨（裏打ち）を優先・上塗りは弱め・自己物語は蒸留しない（§夢の蒸留は外界 grounded 既済）。背骨／上塗りの構造的な区別がそのまま蒸留の信頼度になる。

**importance（任意の補正）**: 情動採点（内心更新）で、行動結果に裏打ちされたターンは符号化を少し強めにしてよい（LLM 申告でなく背骨の有無で機械的に）。やり過ぎないなら任意。

**段階**:
- 第一段（本丸・コードで効く・小モデルの規律に依存しない）: エピソード本文を「機械の事実背骨＋内省の上塗り」で組む＋`INTROSPECTION_SYSTEM` を感情の層に限定。これで主経路を断つ。
- 第二段（任意）: 背骨／上塗りを別フィールドに分け、recall / dream が信頼度を明示区別。importance に背骨補正。

**着手点**: `src/roles/introspection.ts`（内省出力）・`INTROSPECTION_SYSTEM`（`src/prompts/roles.ts`）・`src/orchestrator/turn.ts` の `persistReflection`（エピソード本文の合成）。

---

## 内省の見える範囲 / importance の位置（2026-06-14）

**観察**: importance（記憶の残りやすさ＝気にかけ度＝**情動的顕著性**）を内省（`runIntrospection`）が採点していたが、内省は感情がまだ無い時点で走る。ターン順は `… → 言語野 → 内省 → 内心更新(affect生成) → episode append`。つまり**情動で符号化強度を決めるべき importance を、情動が生まれる前に採点していた**（記憶の符号化が情動で強まる、という古典が効かない）。

**デッドロック懸念と解消**: 「順番を逆転（内心→内省）すれば内省が感情を見られる」は、内省⇄内心の相互依存でデッドロックを招く。だが**循環はデータ上には無い**。本当の地面は「ターンの出来事（発話＋ActionFacts）」で、内省本文も affect も**そこから派生する兄弟**（affect が内省本文を必要としているわけではない・便宜上食わせているだけ）。内省の出力のうち①本文は感情不要、②importance だけが感情を要する。

**設計**: 順番は変えず、**importance を内心更新（`updateAffectAndConcern`）の出力へ移す**。内心更新は既に「出来事＋内省本文＋前の余韻」を見て affect を生成しており、その**同じ呼び出しで importance も付けられる**＝生まれたての感情を根拠にできる。線形・循環なし。
- `IntrospectionOutput` から importance を削除（本文 `{text}` のみ）。
- `AffectAndConcern` に importance 追加、出力 `{affect, concern, importance}`。zod schema＋format を付与（旧 raw JSON.parse を堅牢化）。importance 欠落・型ズレは既定値5でフォールバック（affect/concern は拾う）。
- `turn.ts` の episode append は `affectResult.importance` を使う（内心更新は append の前に走るので順序OK）。
- AFFECT_CONCERN_SYSTEM に「**いま書いた気持ち（affect）の動きの大きさを根拠に** importance を採点」を明記。

**内省の視野で未着手**: 背景の記憶（このターン想起したもの）と直前 affect は依然 reflection messages に入っていない。情動以外の符号化シグナル（過去との響き合い）は今回は触らず。body/sensory チャンネルの不在は設計レベルの別件。

---

## 記憶系アクターの分割統治＝記憶 faculty（B'・2026-06-14）

**動機**: recall/forget/memo の3アクターが独立並列 activate（中央ジャッジ無し）で縄張り衝突。forget が起動せず（stateConfig 漏れ＝別途修正）、「記憶から消して」に memo が誤爆してノートを書いた。各 activate は独立自己選択なので「forget を memo に勝たせる」術が無く、ペア対症は永久に続き＆プロンプト肥大。

**却下**: 「記憶統括くん」＝記憶ドメインのジャッジ。CONCEPT の核（単一の意思決定者を置かない・分離脳の左脳モデル）に反する。

**採用（B'）**: 性質で2 facultyに束ね直す。HAL の決め手＝「**記憶≠記録**。記録は能動的にやる以上それが正本だから別物として束ねる」。
- **記憶 actor (`memory`)** = recall + forget を統合。activate が1判断で op∈{想起, 忘却}＋intent を出し（強制ギプス＝plan/memo と同型・ジャッジではなく自律アクターが自分の op を選ぶ）、run が `runRecallLoop`/`runForget` に振る。エピソード記憶に対してできるのは **Read(想起)+Delete(忘却) のみ＝受動**。能動的 Create/Update は無い（書き込み＝符号化は内心更新の importance 採点であって直接 write op ではない）。
- **記録 actor (`memo`)** = 据え置き。notes ファイルの **full CRUD**（能動・厳密・正本）。
- op の受け渡し: `ActorActivateResult`/`ActorRunInput`/`ActiveActorSpec` に optional `op` を追加し activate→run へ通す（generic は未設定＝無害）。

**効果**: forget↔memo の境界が動詞の取り合いでなく**自然種**（思い出す世界 vs 書き留める世界）に。recall↔forget の混同は同一 actor 内 op 選択で消滅。3 actor→2 faculty・各 activate は自分のレーンのみ宣言＝プロンプト肥大回避。共起は維持（memory と memo は別アクターで並列＝「思い出して→書く」は残る）。実機で recall/forget 両 op の発火・softDelete 実行を確認。`src/actors/recall.ts`・`forget.ts`（薄いラッパ）は削除、run 関数 `runRecallLoop`/`runForget` は温存。

---

## LanceDB の SQL フィルタは camelCase 列で引けない（2026-06-14）

**症状**: `episodes` の `turnId` 列を `where("turnId = '...')` で引くと0件（または「列なし」エラー）。`softDelete`/`updateImportance` が turnId で絞っていたため**静かに空振り**していた（forget が実際には消せていない・CLI 再採点が無反応）。一方 `state='対話'` 等は普通に効く。

**原因（version でも encoding でもない）**: `@lancedb/lancedb 0.22.3`（内部 lance-datafusion 0.39.0）の **camelCase 列名 × クォート挙動の罠**。
- 無クォート識別子 → datafusion が**小文字化** → `turnId` が `turnid` になり「No field named turnid」エラー。
- 大文字を保つにはダブルクォート必須 → だが**この版はダブルクォート識別子だと値マッチが 0 になる不具合**（`"state"='対話'`→0、`state='対話'`→410 で再現）。
- ＝ **camelCase 列はどちらでも引けない**。小文字列（`id`/`state`/`source`/`body`/`timestamp`/`deleted`）は無クォートで正常。

**対処**: SQL フィルタは必ず**小文字列で無クォート**。turnId で絞りたい所は **`id` 列で引く**（append が `id: turnId` と同値をセットしているので等価。`id` は小文字なので無クォートで効く）。`softDelete`/`updateImportance` を `id = '...'` に修正済み（実データで検証済み）。semantic-lancedb は元から `id` 使用で無事。

**やってはいけない**: lance の `.where()`/`update({where})` でダブルクォート識別子を使う・camelCase 列名で絞る。新しい列はクエリで絞るなら snake_case にする。

**余談**: 調査中に「`optimize()` で string フィルタが壊れた」と誤認したが、実際はテスト側でクォート有無を切り替えていただけ。DB は無傷・recall（無クォート）は終始正常。バージョン上げや再エンコードは不要だった。

---

## LLM 同時実行リミッタと一過性リトライ（2026-06-14）

**問題**: 毎ターン頭の活性化バースト（各 actor の `activate` が並列に走る）で Ollama サーバを溢れさせ、undici のヘッダ/ボディタイムアウト（数分かけて失敗）を踏んでいた＝詰まり。

**判断**: 待ち行列を**サーバ内でなく bot 内**に持つ。chat / embed を含む全 LLM 呼び出しを、プロセス全体で共有する 1 つの同時実行リミッタ（`p-limit`）越しに通す（`src/llm/limit.ts` の `runLimited`）。クラウド client に差し替えても同じ経路を通せる。
- 上限は `settings.ollamaMaxConcurrency`（既定 2・保守的）。サーバの `OLLAMA_NUM_PARALLEL` と同値に揃えると溢れさせずパイプを満杯にできる（現状 4）。
- リトライは**速く失敗する一過性エラーのみ**（接続瞬断・429・5xx 等）。**ヘッダ/ボディタイムアウト（5分級）はリトライしない**——倍待つだけで、これは同時実行リミッタで「予防」する種類のもの（`isRetriableLlmError` が `HEADERS_TIMEOUT`/`BODY_TIMEOUT` を除外）。

## 夢の蒸留は外界 grounded・自己はエピソードから蒸留しない（2026-06-14）

**問題**: 意味記憶の蒸留が、内省（事後の作話的な語り）から確信的な自己事実（「わたしは〜」）を固める招きと、話者混線（ある人の家族の話を別の人の事実にする）を持っていた。

**判断**（`DREAM_DISTILL_SYSTEM`・`src/prompts/roles.ts`）:
- エピソードからは**「相手・世界について実際に語られた／起きた事実」だけ**蒸留する。**自己物語はエピソードから作らない**——自己像は persona（character.md）＋夢のタネが正本。内省から確信的な自己事実を固めない。
- 夢のタネ（起動前の素朴な自己認識）からの自己理解はそのまま蒸留してよい。
- 話者を取り違えない／連想・推測で埋めない／出どころ不明の固有名詞は書かない。

---

## 禁止事項

- キーワードマッチでの直行ルーティング
- actor の知覚チャンネル宣言を無視したアドホックな TurnContext トリム（チャンネル宣言による設計上の分離は許容）
- ヒューリスティックによるエージェントのスキップ（活性化判断は必ず LLM で行う）
- `memo_write` 成功時に `episodes` へ直接追記すること（上記 §メモインデックスの設計 参照）
- フィルタ・コンテキスト縮小を理由に元データ（LanceDB・state.json）を削除・変更すること
