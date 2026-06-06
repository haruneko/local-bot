# 技術・設計決定ログ

CONCEPT.md の思想は変えず、実装判断だけをここに固定する。

## ランタイム

| 項目 | 決定 |
|------|------|
| 言語 | **TypeScript** (Node 20+) |
| パッケージ管理 | npm |
| テスト | Vitest（ユニット中心、LLM 統合テストなし） |
| LLM 主 | Ollama `@ http://192.168.16.1:11434`（`OLLAMA_HOST` で上書き） |
| チャットモデル | `gemma4:e4b` |
| 埋め込み | `nomic-embed-text:latest`（`/api/embed`） |
| クラウド逃げ | `LlmClient` アダプタ差し替え。structured output 非対応時はプロンプト+パース+1リトライ |
| Ollama think | `config/settings.json` の `ollamaThink`（既定 `false`）。`OLLAMA_THINK` 環境変数で上書き可 |

## ジャッジ出力

- Ollama `format` に JSON Schema（Zod → `zodToJsonSchema`）
- `ACTION`: 常に object `{ kind, intent }`。`kind: "none"` のとき `intent: ""`
- 選べる kind: `none`, `memory`, `research`, `express`（ACTION-DESIGN.md 参照）。具体ツールはサブエージェントが選ぶ
- `NEXT_STATE`: バリデーションなし。そのまま State に代入し、未知値はログのみ

## 内省くんの入力（CONCEPT からの拡張）

- ジャッジの 3 スロット原文・ツール実行ログは渡さない
- **直近の会話**（作業記憶チャンネル）+ **いま自分が言ったこと** + **行動の結果サマリ**（該当時のみ）を渡す
- `ACTION.kind` が `none` → 行動セクション省略
- それ以外 → 「やろうとしたこと」「できた / できなかった」を自然言語で渡す（ツール名・スタックトレース・LLM 生応答は不可）
- `REPLY=false` → 発話は `（返答はしなかった）`（`ctx.reply` 経由、一人称なし）

## レイヤモデル（用語固定）

- **認知の3層**: 入力（プリプロセス）→ 判断（ジャッジ）→ 行動/出力（サブエージェント → 言語野/Reply・内省/Memory）。入力層が起点で、全ロールが同一 `TurnContext` を参照する
- **アクション意思決定の2段**: 行動・出力層の内部で、ジャッジ（カテゴリ）→ サブエージェント（具体ツール）の2段ディスパッチ
- 「3層」と「2段」は別レベル。2段は3層の行動・出力層の内側に収まる。詳細は [ACTION-DESIGN.md](./ACTION-DESIGN.md)

## 行動くん（v0.5）

- ジャッジは **3カテゴリ**（`memory`, `research`, `express`）+ `none` のみ選ぶ
- 行動くんはカテゴリ別 **サブエージェント**へディスパッチ。サブエージェントがツールを選び LLM + 機械処理/MCP を実行
- 記憶ツール: `remember`, `recall`, `forget`, `memo_write`, `memo_read`, `distill`（スタブ）
- `forget`: LanceDB ソフト削除（`deleted` 列）。物理削除しない
- 探索・発信: MCP（`config/mcp.json`）。未接続時は Fake スタブツール
- 発信文面: 共有言語機能（`language-faculty.ts`）で persona 一元生成
- 発信安全: `expressDryRun` 既定 `true`（`EXPRESS_DRY_RUN` で上書き可）
- メモ I/O は in-process。探索・発信は MCP アダプタ経由

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

## ターンコンテキスト（1ターン限りの引き回し）

- 1ターンにつき **1つの `TurnContext`** を作成し、preprocess → ジャッジ → 行動 → 言語野 → 内省の各段階で **同じオブジェクトを更新**する
- ターン終了時に破棄する（永続化は内省→LanceDB のみ）
- ジャッジ・言語野・内省は **同じ事実データ**（相手発話・直前会話・想起）を参照する。system プロンプトと出力形式だけがロールごとに異なる
- ロールごとに別フォーマットで入力を組み立てない（`TurnBrief` / `VolatileContext` 二重経路は廃止）
- ジャッジ・言語野は `memorySnapshot(ctx)` から同じ事実フィールドを参照する
- 内省は `ctx.judge` を参照せず `ctx.reply` + `ctx.speech` + `ctx.action.facts` のみ
- 行動成功時の構造化事実は `ActionFacts`（`action/facts.ts`）。表示は `action/present.ts`
- 作業記憶のボット発話ラベルは固定の「自分」（`BOT_SPEAKER_LABEL`）。一人称の口調は `persona/character.md` のみ

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

- `shouldRunLanguage(ctx)`: `ctx.reply` または（heartbeat かつ ACTION 成功）
- `shouldPersistIntrospection(ctx)`: user_message は常に。heartbeat は ACTION 成功・REPLY 発話・独り言のいずれかがあるときのみ
- idle heartbeat は内省 LLM と LanceDB 追記をスキップ

## 禁止事項

- キーワードマッチでの直行ルーティング（旧 router 復活）
- ロールごとに想起・会話ログの入れ方を変えること
- ヒューリスティックでジャッジをバイパスすること
