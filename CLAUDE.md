# CLAUDE.md

このファイルは Claude Code がこのリポジトリで作業するときのガイドです。

## プロジェクト概要

ローカル LLM（Ollama）で動く自宅向け対話エージェント。**意思決定・行動・言語化・内省を構造的に分離**し、小さいモデルでも破綻しにくくする設計。分離脳の左脳モデルに倣い、言語化と内省は行動の「原因」ではなく「結果」として後付けで生成される。

設計思想は [docs/CONCEPT.md](docs/CONCEPT.md)、実装契約は [docs/SPEC.md](docs/SPEC.md)、実装判断は [docs/DECISIONS.md](docs/DECISIONS.md)、行動設計は [docs/ACTION-DESIGN.md](docs/ACTION-DESIGN.md)。コードを変える前に、関連する MUST 節と決定ログを確認すること。

## コマンド

```bash
npm run dev          # REPL 起動（= npm start, tsx 実行・build 不要）
npm run heartbeat    # 1 ターンだけ heartbeat して終了（cron 向け）
npm run dream        # 夢バッチ: エピソード/タネを意味記憶へ蒸留
npm run dream -- --seed          # 初回: 夢のタネを蒸留（エピソード 0 件でも可）
npm run dream -- --seed --force-seed  # タネを再蒸留
npm test             # Vitest（LLM 統合テストなし）
npm run test:watch
npm run build        # tsc
npm run smoke        # Ollama 疎通確認
```

CLI 共通オプション: `-v`/`--verbose`（stderr 詳細ログ）, `--user <id>`, `--memory-only`（インメモリ記憶・テスト用）。
REPL 内コマンド: `/quit`, `/heartbeat`, `/state <値>`。

## アーキテクチャ

### 認知の3層（ターン全体のパイプライン）

```
[入力] プリプロセス → [判断] ジャッジ → [行動/出力] サブエージェント → 言語野 → 内省 → 内心更新 → LanceDB
```

- **入力層** (`src/context/preprocess.ts`): センサー・永続記憶・作業記憶から揮発コンテキスト `TurnContext` を組む。アーキテクチャの起点。
- **判断層** (`src/roles/judge.ts`): `ACTION {kind, intent}` / `REPLY` / `NEXT_STATE` を埋めるだけ。ロールプレイ・言語化はしない。
- **行動・出力層**: 行動くん (`src/roles/action.ts`) がカテゴリ別サブエージェントへディスパッチ → 言語野 (`src/roles/language.ts`) → 内省 (`src/roles/introspection.ts`) → 内心更新 (`src/roles/inner-state.ts`)。

1ターンの統括は `src/orchestrator/turn.ts`。フェーズ順は固定（SPEC §4.2）。

### アクション意思決定は2段ディスパッチ

行動・出力層の**内側**の話で、3層とは別レベル。混同しないこと。

1. ジャッジが**抽象カテゴリ**を選ぶ: `none` | `memory` | `research` | `express`
2. カテゴリサブエージェントがツールカタログから具体ツール＋引数を選んで実行

| kind | サブエージェント | 実行層 | ツール |
|------|------------------|--------|--------|
| `memory` | 記憶 | in-process | `remember` `recall` `forget` `memo_write` `memo_read` `distill`(スタブ) |
| `research` | 探索 | MCP（読取系） | `web_search` `browse_url` `calendar_read` 等 |
| `express` | 発信 | MCP（書込系）+ 共有言語機能 | `post_tweet` `calendar_write` 等。既定 dry-run |

### TurnContext（最重要の不変条件）

- 1ターン = **1つの `TurnContext`** を全フェーズで使い回し更新する。ターン終了で破棄（永続化は内省→LanceDB のみ）。
- ジャッジ・言語野・内省は**同じ事実データ**を参照する。`memorySnapshot(ctx)` 経由。**ロールごとに別フォーマットで入力を組み立てない**。
- 内省は `ctx.judge` を見ない。`ctx.reply` + `ctx.speech` + `ctx.action.facts` のみ（判断プロセス・ツールログは渡さない）。
- 行動成功時の構造化事実は `ActionFacts` (`src/action/facts.ts`)、表示は `src/action/present.ts`。`summary` の regex 再パースはしない。

## 記憶の二系統（鮮明さが違う）

| 系統 | 保存先 | 読み出し時の方針 |
|------|--------|------------------|
| エピソード記憶 | `data/lancedb/` `episodes` | LLM 要約・グラデーション（full/summarize/vague）OK＝ふんわり思い出す |
| 意味記憶 | `data/lancedb/` `semantic` | 夢で蒸留した知識 |
| 共有メモ | `data/notes/*.md` | **既存本文を LLM で要約・改変しない**。全文を `facts.body` に載せる |
| 作業記憶 | `data/state.json` | ユーザーとボットの**表面発話のみ**。ジャッジ・ツール結果は含めない |
| 内心ステート | `data/state.json` `innerState` | 持ち越す生の感情（余韻）。内省が毎ターン書き換える。空＝起きたて |

想起グラデーションは `src/recall/distance.ts`（距離分類）+ `src/recall/llm-present.ts`（LLM 提示）。閾値は `DEFAULT_RECALL_DISTANCE_THRESHOLDS`。

## 設定

| ファイル | 内容 |
|----------|------|
| `config/settings.json` | モデル名・Ollama ホスト・記憶件数・トークン予算 |
| `config/mcp.json` | MCP サーバ定義・`expressDryRun` |
| `config/users.yaml` | 話者 ID → 表示名 |
| `persona/character.md` | キャラクター・口調・一人称 |
| `data/semantic-seed.json` | 夢のタネ（内省風断片） |

環境変数: `OLLAMA_HOST`（settings より優先）, `OLLAMA_THINK`, `EXPRESS_DRY_RUN`。

ランタイム: TypeScript / Node 20+ / npm / Vitest。LLM は Ollama（`LlmClient` アダプタで差し替え可、`src/llm/`）。

## やってはいけないこと（DECISIONS.md より）

- キーワードマッチでの直行ルーティング（旧 router 復活）
- ロールごとに想起・会話ログの入れ方を変えること
- ヒューリスティックでジャッジをバイパスすること
- メモ（`data/notes/`）本文を LLM で要約・改変すること（新規作成と pick のみ LLM 可）
- 理由のない暗黙トリム（preview・verbose の truncate は別）

## テスト方針

テストは SPEC の MUST 節を根拠に書く（TDD）。LLM 統合テストは持たず、`src/llm/fake.ts` / `src/mcp/fake.ts` のフェイクを使う。テストは `tests/*.test.ts`。
