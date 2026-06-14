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

- メモ書き込み成功時に upsert（`src/roles/memo.ts`・統合 memo actor。旧 `memo-write.ts`/`memo-read.ts` は廃止）
- 読み（locate）は **recall 認識（top-k 一覧を見て対象を認識・明確一致は必ず再利用）を主**、連想ディセントをフォールバックに（`src/memo/descent.ts`・[MEMO-TREE.md](MEMO-TREE.md)）。削除/1行修正は行 op（`replace_line`/`delete_line`）
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

### 問題B: 行動の結果が次ターンに残らない ✅ 解決済み（集中 State＋構造化 plan）

~~1ターン内の多段（`MAX_SUBAGENT_STEPS=3` / `MAX_RECALL_STEPS=3`）は実装済みだが、**クロスターンの連続行動**の設計がない。例: webSearch でAを調べた → 次のハートビートで「Aの結果を踏まえてBを深掘りしよう」が成立しない。当初の解決方向は `agenda` フィールド案だった。~~

**解決（`agenda` フィールドは作らず、集中 State＋構造化 plan に寄せた）**:
- 構造化 plan（`data/plans/<id>.json`）が `current`（次のマイルストーン）＋`log`（やったこと）を持つ＝駆動型タスクの agenda 本体。
- **sticky 集中**（`turn.ts`）: 未達の `focusPlan` を持つ間は集中を維持。とくに**ハートビートでも維持**するので「A を調べた→次の heartbeat で続きを前進」が繋がる（B が「繋がらない」と言っていた当のケース）。
- 計画チャンネルが集中ターン中に plan を常駐注入（`renderPlan`）。`MAX_FOCUS_STREAK`（強制ギプス）で暴走を止める。
- 残る非集中（対話・静穏）での連続性は workingMemory 独り言＋concern 頼みの弱い経路だが、「駆動して前進」は集中の役割なので許容。

### 問題C: language-agent の format:JSON が口調を抑制する可能性 ❌ 取り下げ

~~`generateDialogueSpeech` の `format: languageJsonSchema` が JSON 生成モードに傾け、会話の温度感が失われる可能性。~~

**取り下げ理由（2026-06-14）**:
- 「format 強制で口調が硬い」は**仮説のまま**で、実機で硬さを format 由来と観測できていない。
- format を外す代償が重い: `nextState` の確実な取得が消える／2パス化（speech と nextState を別呼び出し）は 30B で1呼び出し増。仮説のために実測の信頼性を払う取引。
- 壊れても素直に劣化する: `parseLanguageOutput` の素テキスト fallback が裸文字列をそのまま発話扱い（＝硬い JSON モードを外れた自然な口調）にし、nextState は現 state 維持に落ちるだけ。**raw 漏れも無い**。
- JSON 信頼性が実害になるのは language ではなく activate（パース失敗→null→起動漏れ）だが、slack.log で `llm_parse_failed` は **0 件**。過去の失敗は全てタイムアウト（詰まり）で、同時実行リミッタ（`src/llm/limit.ts`）で手当て済み。

→ format:JSON は `nextState` 信頼性のため**維持**。口調が硬いと観測されたら再検討する観察項目に格下げ。

### 問題D: heartbeat の会話文脈が multi-turn を使わない ✅ 対処済み

~~user_message トリガーは `buildLanguageDialogueMessages` で会話履歴を Ollama multi-turn messages として渡す。heartbeat は `renderLanguageUserContent` で全コンテキストを1つの user message に詰め込む。直近の独り言が過去ターンに埋もれやすい。~~

`generateDialogueSpeech` のハートビート専用分岐を削除し、両トリガーとも `buildLanguageDialogueMessages` を経由するよう統一。heartbeat は `buildConversationTurns({ includeMonologue: true })` で直前の独り言が `role: "assistant"` として multi-turn に入る。詳細は DECISIONS.md §ハートビート言語野のフォーマット統一。

---

## 次にやること（おすすめ順）

### 1. ~~filesystem MCP の導入（サブディレクトリ書き込み）~~ ✅ memo-tree で解決

**状態:** 解決済み（filesystem MCP は不要になった）  
当初の課題「エージェントがサブディレクトリにファイルを書く手段がない」は、**統合 `memo` actor の `writeNoteContent`（`safePath` でサブディレクトリ保全・親フォルダ自動作成）** で解消。MOC ツリーが話題フォルダを自前で作り、`_index.md` を機械再生成する（[MEMO-TREE.md](MEMO-TREE.md)）。旧 `normalizeWriteArgs` のフラット化制約を回避する専用プリミティブ（`writeNoteContent`）を用意したため、外部 filesystem MCP に頼る必要がなくなった。

### 2. 自発的な `distill`（蒸留を会話中にも）

**状態:** 蒸留は `npm run dream` バッチで動作中。会話中に自発実行する action-tool 経路は、legacy カテゴリ・サブエージェント削除（2026-06）と共に撤去済み＝再導入は新規作業。  
**前提:** なし（filesystem MCP 不要に）

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
- **State 拡張の可能性**: 現状 `対話` / `静穏` / `集中` の3値（`集中`＝focusPlan に取り組むモード・追加済み）。さらに表現しきれなくなる可能性はログを観察してから設計（CONCEPT.md §State 参照）

**設計上の最重要制約**: 自律性を持たせる部分こそ「予測ゲートの罠」に最もはまりやすい。  
「次に何をしたいか」ではなく「前のターンで何が起きたか（結果の観測）」を起点に行動を決める設計を守ること。

---

## 廃止・不採用

| 項目 | 理由 |
|------|------|
| `selfStatus` / `runUntilSettled`（クロスターンループ） | サブエージェント内部ループ（`done=false` 多段ステップ）で原理的に解決可能。暴走リスクの方が高かった。詳細: `docs/archive/deliberation-plan-deprecated.md` |
