# ロードマップ

実現したいこと・優先順・設計上の注意をまとめる。  
実装前に必ず [DECISIONS.md](./DECISIONS.md) の禁止事項と本書の制約節を確認すること。

未実装項目は**おすすめ順（上が優先）**で並べている。

---

## フェーズ 1 ── メモ知識ベース改善

**問題:** `memo_write` はファイルに書くが「どこに書いたか」を後から引き出せない。  
「どこに書いたか」はエピソード記憶でも意味記憶でもなく**情報源記憶（ソース記憶）**であり、現在その置き場がない。  
詳細な設計判断は DECISIONS.md §メモインデックスの設計 を参照。

### 永続層の4層構造（確定）

| 層 | 保存先 | 目的 | 性質 |
|----|--------|------|------|
| エピソード記憶 | LanceDB `episodes` | 体験・感情の再構成 | ふんわり・減衰してよい |
| 意味記憶 | LanceDB `semantic` | 蒸留された知識・理解 | 凝縮・長持ち |
| **メモインデックス** | LanceDB `memo_index` | 「どこに何を書いたか」の所在管理 | 正確・機械的・減衰しない |
| メモ本文 | `data/notes/<階層パス>/*.md` | 参照元の全文（不変） | ファイルシステムそのまま |

### A. `memo_index` テーブル実装 ✅ 完了

`memo_write` 成功時に `memo_index` へ機械的に記録する（LLM 不要）。

- `memo_write` 成功時に upsert（`src/roles/memo-write.ts`）
- `memo_read` の pick がベクトル検索ベースに移行済み（`src/roles/memo-read.ts`）
- プリプロセスで `memo_index` も並走検索し、`recalledNotes` として全ロールに渡す（`src/orchestrator/turn.ts`）
- `episodes` には書かない（カテゴリ違反。DECISIONS.md 参照）

### B. 階層ファイルシステム（読み取り側）✅ 完了

- `data/notes/` のサブディレクトリ対応（`readdir` に `recursive: true`）
- `readNoteContent` / `listNoteFilenames` がサブディレクトリパスを処理できる
- `memo_index` も階層パスを保持できる（`path_segments`, `depth_1~3`）

**Obsidian 互換**: `data/notes/` を Obsidian の Vault として開くだけで  
グラフビュー・バックリンク・全文検索が使える。追加実装ゼロ。

---

## 自律動作の既知問題（設計上の構造欠陥）

実装が進んで観察できてきた、**会話らしくならない・続けての行動が苦手・ドライブされていない**という問題群。ROADMAPの優先順を決める際にこれらを念頭に置くこと。

### 問題A: 認知的焦点の欠如 ✅ 設計済み（実装待ち）

~~`state.json` は `{ state, workingMemory, innerState }` の3フィールドのみ。`innerState` は感情余韻であり「何に取り組んでいるか」という行動的な意図を持たない。~~

**設計**: `innerState` を `affect`（感情余韻）に改名し、`concern`（認知的焦点）を別フィールドとして追加する。`affect` と `concern` は 1 回の LLM 呼び出し（`updateAffectAndConcern`）で同時更新される。

- `affect`: 感情余韻。言語野の温度素材
- `concern`: 「何に注目しているか」。actor activate の inner_state チャンネルに含まれ、recall クエリにも使われる（`concern → affect → null` の優先順）
- 前回 concern を入力として渡すことで、「同じ concern が続いている＝何かが行き詰まっている」を LLM が自然に認識できる（構造ドリブン）

詳細は DECISIONS.md §affect/concern 分離設計 参照。

### 問題B: 行動の結果が次ターンに「名刺」として残らない

1ターン内の多段（`MAX_SUBAGENT_STEPS=5`）は実装済みだが、**クロスターンの連続行動**の設計がない。

例: webSearch でAを調べた → 次のハートビートで「Aの結果を踏まえてBを深掘りしよう」が成立するには、workingMemory 内の独り言「次はBを調べよう」が actor の activate に届く必要がある。これは現在 ACTOR_CONTEXT_TURNS=3 で機能する可能性があるが、独り言が「調べたい気持ち」という感情的表現だと具体的なクエリにならない。

**現状の伝達経路**: webSearch 結果 → 独り言（workingMemory）→ 次のhartbeat の recall クエリ → webSearch activate（conversation + inner_state チャンネル）。理論上は繋がっているが、actionModel=8B で innerState の感情表現から具体的な検索意図を抽出するには情報が粗い。

**解決の方向**: agenda フィールドに「調べ終えたこと・次のクエリ」を明示的に書き込めば接続性が上がる。

### 問題C: language-agent の format:JSON が口調を抑制する可能性

`generateDialogueSpeech` が Ollama の `format: languageJsonSchema` を使って `{speech, nextState}` を structured output で取得している。Ollama の JSON フォーマット強制はモデルを JSON 生成モードに傾けるため、会話の温度感・自然な言い回しが失われやすい。

特に qwen3.6 系は structured output への制約が強く、「人間らしい雑談」より「情報を整理した返答」になりがち。

**現在の緩和策**: `parseLanguageOutput` のフォールバックで raw テキストをそのまま speech として使う（JSON パース失敗時）。構造化出力が壊れても会話は継続する。

**観察ポイント**: `--verbose` で language-agent の raw 出力が JSON 準拠かどうかを確認する。JSON バリデーション率が高い = format 強制が効いている = 口調が硬くなっている可能性。

### 問題D: heartbeat の会話文脈が multi-turn を使わない ✅ 対処済み

~~user_message トリガーは `buildLanguageDialogueMessages` で会話履歴を Ollama multi-turn messages として渡す。heartbeat は `renderLanguageUserContent` で全コンテキストを1つの user message に詰め込む。直近の独り言が過去ターンに埋もれやすい。~~

`generateDialogueSpeech` のハートビート専用分岐を削除し、両トリガーとも `buildLanguageDialogueMessages` を経由するよう統一。heartbeat は `buildConversationTurns({ includeMonologue: true })` で直前の独り言が `role: "assistant"` として multi-turn に入る。詳細は DECISIONS.md §ハートビート言語野のフォーマット統一。

---

## 次にやること（おすすめ順）

### 1. filesystem MCP の導入（1-B の残り）

**状態:** 未実装  
**理由:** 1-A・1-B の読み取り側は完成しているが、エージェントがサブディレクトリにファイルを**書く**手段がない。`normalizeWriteArgs` がスラッシュを含むパスを拒否するため、in-process の `memo_write` は現在フラットなファイル名のみ対応。

- `@modelcontextprotocol/server-filesystem` MCP を `config/mcp.json` に追加
- `list_directory` / `read_file` / `write_file` を research/express から呼べるようにする
- エージェントが自分でディレクトリ構造を決めてファイルを作れるようになる

> `normalizeWriteArgs` のサブディレクトリ対応は filesystem MCP 側で解決する設計のため、in-process 側は変更不要。

### 2. `distill` ツール実装（スタブ解除）

**状態:** スタブ（`memory.ts` で「未対応」を返すだけ）  
**前提:** 1-B filesystem MCP 完了後に着手

実装することで会話中にエージェントが自発的に知識整理できるようになる。

- **中身**: `npm run dream` の処理（エピソード → 意味記憶の蒸留）を in-process 関数として切り出す
- **memo_index 同期を含める**: `distill` 実行時に `data/notes/` をスキャンしてインデックス未登録ファイルを upsert（外部注入ファイルの取り込み）
- **`npm run dream` はラッパーとして残す**: 同じ関数を CLI から呼ぶだけにする
- **heartbeat との連携**: heartbeat が「メモや記憶が増えてきた」と判断したとき自発的に `distill` を呼べる（フェーズ 5 への布石）

> 現状は `npm run dream` の手作業運用で十分。

### 3. LINE 連携（フェーズ 2）

**状態:** 未実装

`src/cli/slack.ts` と同じアダプタ構造で追加できる。既存アーキテクチャへの侵食が少ない。

- LINE Messaging API Webhook → `user_message` トリガー
- `users.yaml` に LINE UID 追加

### 4. 非同期複雑タスク（フェーズ 4）

**状態:** 未実装  
**前提:** なし（ただしフェーズ 5 の基盤になる）

現在の「1ターン = 同期完結」前提を拡張する最初のフェーズ。

- **タスクキュー**: `data/tasks/` 等に永続化された未完了タスクリスト
- **バックグラウンドワーカー**: heartbeat がキューを確認し、未完了タスクを1ステップずつ進める
- **現在の多段想起**（`runRecallLoop`）は「同一ターン内の多段」。これはその手前のステップ

**制約**: タスクの「次に何をすべきか」を実行前に予測してディスパッチしない（予測ゲートの罠）。  
heartbeat がタスク状態（実行済みの結果）を読んで次ステップを決める、事後判断の設計にすること。  
詳細は `docs/archive/deliberation-plan-deprecated.md` §8「得られた知見」参照。

### 5. Google Home 連携（フェーズ 2）

**状態:** 未実装

- Google Assistant Actions SDK / Webhook → `user_message` トリガー
- 音声は先にテキスト変換してから渡す（STT が別途必要で LINE より手間多め）

### 6. センサー入力 ＋ express 拡張（フェーズ 3）

**状態:** 未実装  
**前提:** 外部ハードウェア（ウェブカメラ等）

#### センサー側（プリプロセスへの入力）

- **ウェブカメラ**: 定期キャプチャ → マルチモーダル LLM で記述文に変換 → `TurnContext` のセンサーフィールドへ
- **音声入力**: ウェイクワード検出 → STT 変換 → `user_message` トリガー

`src/sensor/` に追加し、`preprocess.ts` がターン開始時に読む形。CONCEPT.md の「外部センサー群」欄に対応する。

#### express 側（行動としての操作）

- `capture_photo`: ウェブカメラで撮影し画像パスを返す MCP ツール
- `control_camera`: カメラ ON/OFF などの制御

express MCP サーバに追加し、express サブエージェントがカタログから選択する。

### 7. 自律エージェント（フェーズ 5）

**状態:** 未実装  
**前提:** フェーズ 4（タスクキュー基盤）完了後

- **長期ゴール永続化**: `affect`（感情余韻）/ `concern`（認知的焦点）より長いスパンの「自分の議題」を `data/state.json` に持たせる
  - `affect` / `concern` = ターン単位で書き換わる内心
  - 長期ゴール = 複数ターン・複数日にわたる関心・やりかけのこと
- **heartbeat の自発行動**: heartbeat が「応答待ち」ではなく「自分の議題を進める」判断をする
- **State 拡張の可能性**: `対話` / `静穏` の2値では表現しきれなくなる可能性あり。ログを観察してから設計する（CONCEPT.md §State 参照）

**設計上の最重要制約**: 自律性を持たせる部分こそ「予測ゲートの罠」に最もはまりやすい。  
「次に何をしたいか」ではなく「前のターンで何が起きたか（結果の観測）」を起点に行動を決める設計を守ること。

---

## 廃止・不採用

| 項目 | 理由 |
|------|------|
| `selfStatus` / `runUntilSettled`（クロスターンループ） | サブエージェント内部ループ（`done=false` 多段ステップ）で原理的に解決可能。暴走リスクの方が高かった。詳細: `docs/archive/deliberation-plan-deprecated.md` |
