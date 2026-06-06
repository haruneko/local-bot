# local-bot

ローカル LLM（[Ollama](https://ollama.com/)）で動く、自宅向けの対話エージェントです。  
**意思決定・行動・言語化・内省**を分離し、小さいモデルでも破綻しにくい構成を目指しています。

## できること（MVP）

- CLI で対話（ユーザー発話 / ハートビート）
- ジャッジが毎ターン「何をするか」を 5 種類から選択
- **記憶**（LanceDB + ベクトル想起）と **メモ**（`data/notes/*.md`）の二系統
- 内省だけをエピソード記憶に蓄積（`remember` は別途ファクト追記）
- `--verbose` でジャッジ・行動・言語野・内省の入出力を追跡

## アーキテクチャ（1ターン）

```
プリプロセス（自動想起）→ ジャッジ → 行動（5種のいずれか）→ 言語野 → 内省 → LanceDB
```

| モジュール | 役割 |
|------------|------|
| ジャッジ | `ACTION`（kind + intent）, `REPLY`, `NEXT_STATE` |
| 行動くん | 薄いディスパッチのみ（LLM なし） |
| 覚える / 思い出す / メモを書く / メモを読む | 各サブモジュールが LLM + 機械処理 |
| 言語野 | `TurnContext` から組み立てた入力（相手の発話 → 行動 → 直近会話） |
| 内省 | 発話と行動の結果から一人称で振り返り |

詳細は [docs/CONCEPT.md](docs/CONCEPT.md)、行動設計は [docs/ACTION-DESIGN.md](docs/ACTION-DESIGN.md)、実装仕様は [docs/SPEC.md](docs/SPEC.md) を参照してください。

### ACTION の種類

| kind | 意味 |
|------|------|
| `none` | 何もしない |
| `remember` | 会話の事実を LanceDB に保存 |
| `recall` | LanceDB から意識的に掘り出す |
| `memo_write` | `data/notes/` にメモを書く |
| `memo_read` | 既存メモを読む |

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

### 別プロセス（cron 向け）

```bash
npm run heartbeat
# オプションは REPL と同じ: --verbose --user <id> --memory-only
```

1 ターンだけ heartbeat して終了。State と直近会話（作業記憶）は `data/state.json` に永続化される（REPL も heartbeat も同じファイルを共有）。

idle heartbeat（`ACTION=none` かつ `REPLY=false`）は内省を生成・保存しない。
| `/state <値>` | エージェント状態を手動変更（例: `対話`, `静穏`） |

## 設定

| ファイル | 内容 |
|----------|------|
| [config/settings.json](config/settings.json) | モデル名、Ollama ホスト、記憶件数、トークン予算など |
| [config/users.yaml](config/users.yaml) | 話者 ID → 表示名 |
| [persona/character.md](persona/character.md) | キャラクター・一人称 |

環境変数:

- `OLLAMA_HOST` — Ollama の URL（settings より優先）

## データの場所

| パス | 内容 |
|------|------|
| `data/lancedb/` | エピソード記憶（内省・remember） |
| `data/notes/*.md` | 共有メモ（memo_write / memo_read） |

記憶をリセットする場合:

```bash
rm -rf data/lancedb
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
  memory/                # LanceDB・作業記憶
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
| 別のメモを読んだ | `memo_read` のファイル選定は一覧のみ参照。会話文脈の改善は今後の課題 |
| LanceDB エラー | `data/lancedb` を削除して再作成 |

## ライセンス

`private: true` の個人プロジェクト想定。リポジトリ公開時は LICENSE を追加してください。
