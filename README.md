# local-bot

ローカル LLM（[Ollama](https://ollama.com/)）で動く、自宅向けの対話エージェントです。  
**意思決定・行動・言語化・内省**を分離し、小さいモデルでも破綻しにくい構成を目指しています。

## できること（MVP）

- CLI で対話（ユーザー発話 / ハートビート）
- ジャッジが毎ターン「何をするか」を 3 カテゴリ（記憶/探索/発信）から選択
- **記憶**（LanceDB + ベクトル想起）と **メモ**（`data/notes/*.md`）の二系統
- **意味記憶**（夢バッチでエピソード + 夢のタネから蒸留）
- 内省だけをエピソード記憶に蓄積（`remember` は別途ファクト追記）
- `--verbose` でジャッジ・行動・言語野・内省の入出力を追跡

## アーキテクチャ（1ターン）

認知の3層 **入力 → 判断 → 行動/出力**:

```
[入力] プリプロセス（自動想起・recency除外）→ [判断] ジャッジ → [行動/出力] サブエージェント → 言語野 → 内省 → 内心更新 → LanceDB
```

アクションの意思決定はこの行動・出力層の内側で2段（ジャッジ=カテゴリ → サブエージェント=具体ツール）。

| モジュール | 役割 |
|------------|------|
| ジャッジ | `ACTION`（kind + intent）, `REPLY`, `NEXT_STATE` |
| 行動くん | カテゴリ別サブエージェントへディスパッチ |
| 記憶サブエージェント | remember/recall/forget/memo_read/memo_write（distill は `npm run dream` へ） |
| 探索・発信サブエージェント | MCP ツール（web/SNS 等） |
| 言語野 | `TurnContext` から組み立てた入力（相手の発話 → 内心 → 行動 → 直近会話） |
| 内省 | 発話と行動の結果から一人称で振り返り → 内心ステートを更新 |

詳細は [docs/CONCEPT.md](docs/CONCEPT.md)、行動設計は [docs/ACTION-DESIGN.md](docs/ACTION-DESIGN.md)、実装仕様は [docs/SPEC.md](docs/SPEC.md) を参照してください。

### ACTION の種類（ジャッジが選ぶカテゴリ）

| kind | 意味 |
|------|------|
| `none` | 何もしない |
| `memory` | 記憶操作（覚える/思い出す/忘れる/メモ読書き） |
| `research` | 探索（Web検索・閲覧・予定照会など） |
| `express` | 発信（SNS投稿・予定登録など。既定 dry-run） |

## 必要環境

- Node.js 20+
- Ollama（チャット用・埋め込み用モデル）
- デフォルト設定例（`config/settings.json`）:
  - チャット: `gemma4:e4b`
  - 埋め込み: `nomic-embed-text:latest`
  - ホスト: `http://192.168.16.1:11434`（`OLLAMA_HOST` で上書き可）

```bash
ollama pull gemma4:e4b
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
npm start
# または
npm run dev
```

### CLI オプション

| オプション | 説明 |
|------------|------|
| `-v`, `--verbose` | 詳細ログを stderr に出力 |
| `--user <id>` | 話者 ID（`config/users.yaml`） |
| `--memory-only` | LanceDB を使わずインメモリ記憶（テスト用） |

### 対話中コマンド

| コマンド | 説明 |
|----------|------|
| `/quit` | 終了 |
| `/heartbeat` | ユーザー発話なしのターン（静穏時など） |
| `/state <値>` | エージェント状態を手動変更（例: `対話`, `静穏`） |

### 別プロセス（cron 向け）

```bash
npm run heartbeat
# オプションは REPL と同じ: --verbose --user <id> --memory-only
```

1 ターンだけ heartbeat して終了。State・作業記憶・内心ステートは `data/state.json` に永続化される（REPL も heartbeat も同じファイルを共有）。

idle heartbeat（`ACTION=none` かつ `REPLY=false`）は内省を生成・保存しない。

### 夢（意味記憶の蒸留）

手動または cron で実行します。エピソードがなくても **夢のタネ** から初回の意味記憶を作れます。

```bash
# 初回: 夢のタネだけ蒸留（エピソード 0 件でも可）
npm run dream -- --seed

# 会話後: 増分エピソードを蒸留
npm run dream

# 任意のタネファイル
npm run dream -- --seed data/semantic-seed.json

# タネを再蒸留（通常は 1 回だけ適用）
npm run dream -- --seed --force-seed
```

| オプション | 説明 |
|------------|------|
| `--seed` | `data/semantic-seed.json` を夢のタネとして蒸留に含める |
| `--seed <path>` | 指定ファイルをタネとして使う |
| `--force-seed` | 適用済みタネを再蒸留する |

- エピソード（内省）と夢のタネ（内省風断片）を LLM で蒸留し、意味記憶（LanceDB `semantic`）へ書き込む
- 進捗は `data/dream-state.json`（`lastDreamAt` / `seedAppliedAt`）
- エピソードのみの実行は増分 **3 件未満** ならスキップ（`dreamMinEpisodes` で変更可）
- 次ターン以降、「知っていること（意味記憶）」として会話に載る

典型的な流れ:

```bash
npm run dream -- --seed   # 初回: タネから意味記憶を作る
npm run dev               # 会話開始
npm run dream             # 会話後: エピソードを蒸留
```

## 設定

| ファイル | 内容 |
|----------|------|
| [config/settings.json](config/settings.json) | モデル名、Ollama ホスト、記憶件数、トークン予算など |
| [config/mcp.json](config/mcp.json) | MCP サーバ定義、`expressDryRun` |
| [config/users.yaml](config/users.yaml) | 話者 ID → 表示名 |
| [persona/character.md](persona/character.md) | キャラクター・口調・一人称 |
| [data/semantic-seed.json](data/semantic-seed.json) | 夢のタネ（`npm run dream -- --seed` で蒸留） |

`config/settings.json` の任意キー:

| キー | 既定 | 説明 |
|------|------|------|
| `semanticRecallTopK` | 5 | ターン入力へ載せる意味記憶の件数 |
| `semanticRecallMaxDistance` | 0.75 | 意味記憶 recall の距離上限 |
| `dreamMinEpisodes` | 3 | 夢を実行する最小エピソード件数 |
| `recencyExclusionTurns` | 4 | エピソード想起から除外する直近ターン数 |

環境変数:

- `OLLAMA_HOST` — Ollama の URL（settings より優先）

## 記憶の種類

入力層では次のチャンネルが別枠で流れます（混同しないこと）。

| チャンネル | 保存先 | 性格 |
|------------|--------|------|
| 作業記憶 | `data/state.json`（揮発的に組み立て） | 直近の会話 |
| 内心ステート | `data/state.json` の `innerState` | 持ち越す生の感情（余韻）。内省が毎ターン更新 |
| 知っていること（意味記憶） | `data/lancedb/` の `semantic` テーブル | 夢で蒸留（タネ + エピソード） |
| 背景の記憶（エピソード） | `data/lancedb/` の `episodes` テーブル | 内省のふんわり想起 |
| 共有メモ | `data/notes/*.md` | 意図して残した全文 |

夢のタネの編集例（`data/semantic-seed.json`）。**宣言文ではなく内省風の断片**を書きます（夢が蒸留して意味記憶にする）:

```json
{
  "seed": [
    {
      "body": "まだ会話はほとんどないが、この家のなかでわたしは動く存在だと感じている。",
      "tags": ["core"]
    }
  ]
}
```

編集後は `npm run dream -- --seed --force-seed` で再蒸留します。

## データの場所

| パス | 内容 |
|------|------|
| `data/state.json` | State・作業記憶（会話履歴）・内心ステート（`innerState`） |
| `data/dream-state.json` | 夢の進捗（`lastDreamAt` / `seedAppliedAt`） |
| `data/semantic-seed.json` | 夢のタネ（蒸留前の素材） |
| `data/lancedb/` | エピソード記憶（`episodes`）・意味記憶（`semantic`） |
| `data/notes/*.md` | 共有メモ（memo_write / memo_read） |

記憶をリセットする場合:

```bash
rm -rf data/lancedb          # エピソード + 意味記憶
rm -f data/dream-state.json  # 夢の進捗もリセット（タネ再適用可）
```

スキーマ変更後に `Found field not in schema` が出た場合も、上記で再作成するか、起動時の自動マイグレーション（`source` 列追加）に任せてください。

## 開発

```bash
npm test              # Vitest（LLM 統合テストなし）
npm run test:watch
npm run build
npm run smoke         # Ollama 疎通（scripts/smoke-ollama.ts）
```

## プロジェクト構成（抜粋）

```
src/
  orchestrator/turn.ts   # 1ターンの流れ
  roles/                 # ジャッジ・言語野・内省・行動サブモジュール
  action/                # 型・エラー・言語野/内省向けフォーマット
  memory/                # LanceDB・意味記憶・seed・作業記憶
  roles/dream.ts       # 夢バッチ（意味記憶蒸留）
  tools/notes.ts         # メモファイル I/O
docs/                    # コンセプト・仕様・設計
persona/                 # キャラ設定
config/                  # 実行時設定
```

## トラブルシュート

| 症状 | 対処 |
|------|------|
| 行動が `llm_parse_failed` | LLM が JSON 以外（```json 付き等）を返した。再試行またはプロンプト確認。verbose の `詳細` に生応答あり |
| メモを書いたのに「機能がない」 | 言語野に行動結果が渡る前のビルドだった可能性。再起動し、verbose で「今ターンの行動結果」を確認 |
| 別のメモを読んだ | `memo_read` は冒頭抜粋インデックスで改善済み。さらに精度が要る場合は verbose で pick 入力を確認 |
| LanceDB エラー | `data/lancedb` を削除して再作成 |

## ライセンス

[MIT](LICENSE)
