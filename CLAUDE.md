# CLAUDE.md

このファイルは Claude Code がこのリポジトリで作業するときのガイドです。

## プロジェクト概要

ローカル LLM（Ollama）で動く自宅向け対話エージェント。**実行・言語化・内省を構造的に分離**し、小さいモデルでも破綻しにくくする設計。分離脳の左脳モデルに倣い、言語化と内省は行動の「原因」ではなく「結果」として後付けで生成される。単一の意思決定者（ジャッジ）は存在せず、各エージェントが同一の観測事実（TurnContext）から自律的に判断して動く。

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

### 認知の構造（ターン全体のパイプライン）

```
[入力] プリプロセス（想起） → [自律] actor pool（並列） → language-agent → 内省 → 内心更新 → LanceDB
```

- **プリプロセス** (`src/context/preprocess.ts`): 想起クエリ決定（`lastUserContent → lastSpeech → concern → affect → null`）→ LanceDB 想起 → `TurnContext` 生成。フィルタは量を絞るだけで元データは変更しない。
- **actor pool** (`src/actors/`): `recall` `remember` `forget` `memoWrite` `memoRead` `webSearch` `urlBrowse` `webcam` が独立して並列に起動判断・実行。各 actor が `activate()` で自己判断し、起動した actor のみ実行。mini-context（直近3ターン）で判断。
- **language-agent** (`src/roles/language.ts`): 全 facts を受け取り発話生成 + NEXT_STATE を出力。常に起動し発話するかを内部で決める。
- **内省** (`src/roles/introspection.ts`) → **内心更新** (`src/roles/inner-state.ts`)。

1ターンの統括は `src/orchestrator/turn.ts`。フェーズ順は固定（SPEC §4.2）。

### TurnContext（最重要の不変条件）

- 1ターン = **1つの `TurnContext`** を全フェーズで使い回し更新する。ターン終了で破棄（永続化は内省→LanceDB のみ）。
- 全エージェント・内省は**同じ事実データ**を参照する。`memorySnapshot(ctx)` 経由。**ロールごとに別フォーマットで入力を組み立てない**。
- 内省は各エージェントの判断プロセスを見ない。`ctx.reply` + `ctx.speech` + `ctx.actions` のみ（ツールログは渡さない）。
- `ctx.actions: ActionOutcome[]`（actor pool の結果を順不同で追加）。`summary` の regex 再パースはしない。
- 行動成功時の構造化事実は `ActionFacts` (`src/action/facts.ts`)、表示は `src/action/present.ts`。

## 記憶の4層（性質が違う・混ぜない）

| 層 | 保存先 | 読み出し時の方針 |
|----|--------|------------------|
| エピソード記憶 | `data/lancedb/` `episodes` | LLM 要約・グラデーション（full/summarize/vague）OK＝ふんわり思い出す |
| 意味記憶 | `data/lancedb/` `semantic` | 夢で蒸留した知識 |
| メモインデックス | `data/lancedb/` `memo_index` | 「どこに何を書いたか」の所在管理。`memo_write` 成功時に機械的 upsert。減衰しない |
| 共有メモ本文 | `data/notes/**/*.md` | **既存本文を LLM で要約・改変しない**。全文を `facts.body` に載せる。階層ディレクトリ可 |
| 作業記憶 | `data/state.json` | ユーザーとボットの**表面発話のみ**。各エージェントの判断・ツール結果は含めない |
| affect（感情余韻） | `data/state.json` `affect` | 持ち越す生の感情（余韻）。旧 `innerState`。内省後に毎ターン書き換え。空＝起きたて |
| concern（関心事） | `data/state.json` `concern` | 認知的焦点（何に注目しているか）。affect と同じ LLM 呼び出しで更新。actor activate / recall クエリに使う |

`memo_index` はエピソード記憶・意味記憶とは別テーブル（情報源記憶）。`episodes` に書かない（DECISIONS.md §メモインデックスの設計 参照）。  
想起グラデーションは `src/recall/distance.ts`（距離分類）+ `src/recall/llm-present.ts`（LLM 提示）。閾値は `DEFAULT_RECALL_DISTANCE_THRESHOLDS`。

## 設定

| ファイル | 内容 |
|----------|------|
| `config/settings.json` | モデル名・Ollama ホスト・記憶件数・トークン予算・`stateConfig`・`roles` |
| `config/mcp.json` | MCP サーバ定義・`expressDryRun` |
| `config/users.yaml` | 話者 ID → 表示名 |
| `persona/character.md` | キャラクター・口調・一人称 |
| `data/semantic-seed.json` | 夢のタネ（内省風断片） |

環境変数: `OLLAMA_HOST`（settings より優先）, `OLLAMA_THINK`（`roles[*].think` より低優先）, `EXPRESS_DRY_RUN`。

ランタイム: TypeScript / Node 20+ / npm / Vitest。LLM は Ollama（`LlmClient` アダプタで差し替え可、`src/llm/`）。

## やってはいけないこと（DECISIONS.md より）

- キーワードマッチでの直行ルーティング
- ロールごとに想起・会話ログの入れ方を変えること
- ヒューリスティックによるエージェントのスキップ（活性化判断は必ず LLM で行う）
- メモ（`data/notes/`）本文を LLM で要約・改変すること（新規作成と pick のみ LLM 可）
- `memo_write` 成功時に `episodes` へ直接追記すること（`memo_index` へ書く）
- 理由のない暗黙トリム（preview・verbose の truncate は別）
- フィルタ・コンテキスト縮小を理由に元データ（LanceDB・state.json）を削除・変更すること

## テスト方針

テストは SPEC の MUST 節を根拠に書く（TDD）。LLM 統合テストは持たず、`src/llm/fake.ts` / `src/mcp/fake.ts` のフェイクを使う。テストは `tests/*.test.ts`。
