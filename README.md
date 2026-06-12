# local-bot

ローカル LLM（[Ollama](https://ollama.com/)）で動く、自宅向けの対話エージェントです。  
**実行・言語化・内省**を構造的に分離し、小さいモデルでも破綻しにくい設計。

## できること

- CLI / Slack ボットで対話（ユーザー発話 / ハートビート）
- **actor pool**: recall / remember / forget / memo_write / memo_read / webSearch / urlBrowse が並列に自律実行
- **記憶**（LanceDB + ベクトル想起）と **メモ**（`data/notes/`）の二系統 + メモインデックス
- **意味記憶**（夢バッチでエピソード + 夢のタネから蒸留）
- 内省だけをエピソード記憶に蓄積（`remember` は別途ファクト追記）
- **話者対応**: `config/users.yaml` の `note`（関係性）を言語野に注入し、誰と話すかで反応が変わる。想起も話者一致エピソードを重み付け
- **3 段階ログ**: `quiet`（発話のみ）/ `info`（1ターン十数行の構造化サマリ・常駐の既定）/ `debug`（全 LLM 入出力。`-v`）

## アーキテクチャ（1ターン）

```
[入力] プリプロセス（自動想起・recency除外）
  → [actor pool 並列] recall / remember / webSearch / ...
  → [言語野] 発話生成 + NEXT_STATE
  → [内省] → [内心更新] → LanceDB
```

| モジュール | 役割 |
|------------|------|
| activate | 単一の選定者は無し。各 actor が mini-context を読み**自分の起動可否を並列に判断** |
| actor pool | 起動した各 actor が並列に自律実行し `ctx.actions` に積む |
| 言語野 | `TurnContext` 全チャンネル + `ctx.actions` を受け取り発話生成 |
| 内省 | 発話と行動結果から一人称で振り返り → エピソード記憶へ |
| 内心更新 | 内省を受けて `affect`（感情余韻）と `concern`（認知的焦点）を書き換え |

詳細は [docs/CONCEPT.md](docs/CONCEPT.md)、行動設計は [docs/ACTION-DESIGN.md](docs/ACTION-DESIGN.md)、実装仕様は [docs/SPEC.md](docs/SPEC.md)、設計決定は [docs/DECISIONS.md](docs/DECISIONS.md)。

### 行動の種類

| kind | 意味 |
|------|------|
| `memory` | 記憶操作（recall / remember / forget / memo_read / memo_write） |
| `research` | 探索（Web検索・URL閲覧・センサーなど） |
| `express` | 発信（SNS投稿など。既定 dry-run） |

## 必要環境

- Node.js 20+
- Ollama（チャット用・埋め込み用モデル）
- デフォルト設定（`config/settings.json`）:
  - チャット / actor: `qwen3.6:35b-a3b`
  - 埋め込み: `nomic-embed-text:latest`
  - ホスト: `http://192.168.16.1:11434`（`OLLAMA_HOST` で上書き可）

```bash
ollama pull qwen3.6:35b-a3b
ollama pull nomic-embed-text:latest
```

## セットアップ

```bash
git clone <repository-url>
cd local-bot
npm install
npm run build   # 任意（実行は tsx のため build なしでも可）
```

## 起動

```bash
npm start        # CLI REPL
npm run dev      # 同上
```

### CLI オプション

| オプション | 説明 |
|------------|------|
| `-v`, `--verbose` | `debug` レベル（全 LLM 入出力）を stderr に出力 |
| `-q`, `--quiet` | サマリログなし（REPL の既定） |
| `--user <id>` | 話者 ID（`config/users.yaml`） |
| `--memory-only` | LanceDB を使わずインメモリ記憶（テスト用。`say` では state.json も使わず完全使い捨て） |

ログ既定は REPL=`quiet`・Slack/heartbeat=`info`。

### 対話中コマンド

| コマンド | 説明 |
|----------|------|
| `/quit` | 終了 |
| `/heartbeat` | ユーザー発話なしのターン（静穏時など） |
| `/state <値>` | エージェント状態を手動変更（例: `対話`, `静穏`） |

### 別プロセス（cron 向け）

```bash
npm run heartbeat   # 1ターンだけ heartbeat して終了
npm run say -- "メッセージ"            # 1ターンだけ user_message を送って終了（既定話者=クロ）
npm run say -- --user user_001 "..."   # 話者指定
```

State・作業記憶・内心ステートは `data/state.json` に永続化される（REPL も heartbeat も同じファイルを共有）。

idle heartbeat（succeeded なアクションが0件 かつ発話なし）は内省を生成・保存しない。

### 夢（意味記憶の蒸留）

手動または cron で実行します。エピソードがなくても **夢のタネ** から初回の意味記憶を作れます。

```bash
npm run dream -- --seed          # 初回: タネだけ蒸留（エピソード 0 件でも可）
npm run dream                    # 会話後: 増分エピソードを蒸留
npm run dream -- --seed --force-seed  # タネを再蒸留
```

| オプション | 説明 |
|------------|------|
| `--seed` | `data/semantic-seed.json` を夢のタネとして蒸留に含める |
| `--seed <path>` | 指定ファイルをタネとして使う |
| `--force-seed` | 適用済みタネを再蒸留する |

## 設定

| ファイル | 内容 |
|----------|------|
| [config/settings.json](config/settings.json) | モデル名、Ollama ホスト、記憶件数、トークン予算など |
| [config/mcp.json](config/mcp.json) | MCP サーバ定義、`expressDryRun` |
| [config/users.yaml](config/users.yaml) | 話者 ID → 表示名 ＋ 任意の `note`（関係性。言語野へ注入） |
| [persona/character.md](persona/character.md) | キャラクター・口調・一人称 |
| [data/semantic-seed.json](data/semantic-seed.json) | 夢のタネ（`npm run dream -- --seed` で蒸留） |

## 記憶の種類

| チャンネル | 保存先 | 性格 |
|------------|--------|------|
| 作業記憶 | `data/state.json` | 直近の表面発話のみ |
| 内心 affect | `data/state.json` の `affect` | 持ち越す生の感情（余韻）。内省が毎ターン更新 |
| 内心 concern | `data/state.json` の `concern` | 認知的焦点。actor の起動判断・想起クエリに使う |
| 意味記憶 | LanceDB `semantic` | 夢で蒸留した知識 |
| エピソード記憶 | LanceDB `episodes` | 内省のふんわり想起 |
| メモインデックス | LanceDB `memo_index` | 「どこに何を書いたか」の所在管理 |
| 共有メモ | `data/notes/**/*.md` | 意図して残した全文（LLM で改変しない） |

## データの場所

| パス | 内容 |
|------|------|
| `data/state.json` | State・作業記憶・内心ステート |
| `data/dream-state.json` | 夢の進捗（`lastDreamAt` / `seedAppliedAt`） |
| `data/lancedb/` | エピソード記憶・意味記憶・メモインデックス |
| `data/notes/` | 共有メモ（階層ディレクトリ対応・Obsidian 互換） |

記憶をリセットする場合:

```bash
rm -rf data/lancedb          # エピソード + 意味記憶 + メモインデックス
rm -f data/dream-state.json  # 夢の進捗もリセット
```

## 開発

```bash
npm test              # Vitest（LLM 統合テストなし）
npm run test:watch
npm run build
npm run smoke         # Ollama 疎通確認
```

## プロジェクト構成（抜粋）

```
src/
  orchestrator/turn.ts   # 1ターンの流れ
  actors/                # actor pool（recall / remember / webSearch 等）
  roles/                 # 言語野・内省・内心更新・サブエージェント
  context/               # TurnContext 組み立て・メモリスナップショット
  recall/                # 想起グラデーション・距離分類
  memory/                # LanceDB・意味記憶・作業記憶
  action/                # 型・エラー・言語野/内省向けフォーマット
  config/                # 設定解決
  sensor/                # 日時・相対時間
  tools/                 # メモファイル I/O
docs/                    # コンセプト・仕様・設計決定・ロードマップ
persona/                 # キャラ設定
config/                  # 実行時設定
```

## トラブルシュート

| 症状 | 対処 |
|------|------|
| actor が動かない | `--verbose` で activator の判断と各 actor の activate ログを確認 |
| LanceDB エラー | `data/lancedb` を削除して再作成 |
| メモを書いたのに読めない | `--verbose` で `memoRead` の pick 入力を確認 |

## ライセンス

[MIT](LICENSE)
