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

## 身体・存在感（embodied）— いま取り組み中（2026-06〜）

目標は embodied-claude（クラウド Claude に体を付ける MCP 群）。うちは「ローカルの頭に体を付ける」で対になる。
作り方の縛りと全体設計は [ARCH-NEXT.md](ARCH-NEXT.md)（板・フレーム・全部 actor・とっさの返事・非同期想起）。
縛り: 欲を言葉にして持たせない／感情を数値化しない／でかいモデル1個に全部やらせない／見聞きを文字起こしして正本にしない。

**進捗（2026-06-15）**: 受動の視覚 ✅、Slack 画像受信 ✅（実機確認済・花束の写真でエバが反応）。＝「目」が通った。残り = 画像の記憶（embedding＝核は後回し／ピクセル保存＝能動メモは作れる）・能動の見にいく・音声・embedding サブシステム・ARCH-NEXT 本体。

### 視覚

1. **受動の視覚** ✅ 実装済（222b8b7）— `image_feed` チャンネルで生画像を言語野へ（文字起こししない）。`src/sensor/frame.ts`・`settings.imageFeedSource`（既定オフ）。現行 chatModel(qwen3.6:35b-a3b) が vision 対応。周辺視野の注釈付き（景色に引っ張られすぎ対策の第一段・要観察）。
2. **Slack 画像受信** ✅ 実装・実機確認済（2026-06-15・`files:read` 付与済）— Slack の添付画像を `image_feed` の出どころにする。`user_message` トリガーに `images?` を足し、orchestrator は「トリガー画像＞ファイルセンサー」で `imageFeed` に入れる。画像だけのメッセージも通す。`url_private` を bot トークンで DL（スコープ未付与・DL 失敗時は黙ってテキストとして続行）。記憶は当面 v1（下記）。
3. **能動の「見にいく」** — `webcam` actor を能動の見る係として実装。カメラを動かした結果の2枚目を `image_feed` に append（`images` は配列なので自然に並ぶ）。＝行動→結果の視覚版。

### 画像の記憶（キャプションを正本にしない・詳細は [ARCH-NEXT.md](ARCH-NEXT.md)「知覚と記憶ループ」）

人間に倣う＝ピクセルを貯めず、**圧縮した非言語の痕跡（embedding）＋意味のラベル**を持ち、思い出す時に作り直す。役割の違う3層：

- **言葉（反応）✅ 実装済**: 内省が「会話で起きたこと＝エバの反応」をエピソードに書く。画像のキャプションではなく彼女の言葉。画像バイトは揮発（とっさの一言と同じ）。
- **embedding（視覚記憶の核）🔴 後回し**: 画像を embed したベクトルをエピソードに保存→似た過去を recognition（「見たことある」）。**要 embedding サブシステム＋画像 backend**。2026-06-15 判明: **Ollama は画像 embed 不可**（専用モデルは images 無視・生成モデルは 501）＝in-process(transformers.js) か外部で回す（ARCH-NEXT「embedding サブシステム」）。クロスモーダル（言葉↔画像 同空間）は捨てがたく保留。
- **ピクセル保存（写真アルバム・能動メモ限定）🟢 作れる**: エバが「とっておこう」と決めた画像だけ `data/notes/` に保存しノートから参照。受動エピソードはピクセルを持たない（B' の 記憶 vs 記録）。埋め込み不要・自己完結。

### 音声

- **Qwen3-Omni**（end-to-end omni・30B-A3B）。音声を文字起こしせず入れ、音声で返す＝STT/TTS を挟まない。要 `ollama pull`（容量大）。視覚と違い現行モデルには無いのでこれが必須。

### 全体アーキの作り直し（長い射程）

- [ARCH-NEXT.md](ARCH-NEXT.md): 固定フェーズ順をやめてフレーム（時計で進むコマ）に・板1枚（共有 Context）・言語野/内省含め全部 actor・とっさの返事（反射）・別々の非同期想起。ターン版と連続版は時計違いの同じコード。設計済・実装は段階的（受動の視覚はその第一歩）。

---

## 次にやること（おすすめ順）

### 1. ~~filesystem MCP の導入（サブディレクトリ書き込み）~~ ✅ memo-tree で解決

**状態:** 解決済み（filesystem MCP は不要になった）  
当初の課題「エージェントがサブディレクトリにファイルを書く手段がない」は、**統合 `memo` actor の `writeNoteContent`（`safePath` でサブディレクトリ保全・親フォルダ自動作成）** で解消。MOC ツリーが話題フォルダを自前で作り、`_index.md` を機械再生成する（[MEMO-TREE.md](MEMO-TREE.md)）。旧 `normalizeWriteArgs` のフラット化制約を回避する専用プリミティブ（`writeNoteContent`）を用意したため、外部 filesystem MCP に頼る必要がなくなった。

### 2. 自発的な `distill`（静穏 idle で蒸留）✅ 実装済（2026-06-15）

**起動＝静穏 idle ハートビート**（手が空いた時・睡眠中の記憶整理のイメージ。会話中ではない）。

- `runDream`（既に in-process 関数・`src/roles/dream.ts`）を `TurnDeps.runDistill` として注入（`bootstrap.ts`）。
- orchestrator が **heartbeat ＋ state==="静穏" ＋ idle（episode 未保存）** のとき `runDistill` を呼ぶ（`src/orchestrator/turn.ts`）。
- `runDream` は dream-state で「新素材が足りなければ即スキップ」するので毎ターン呼んで安全。タネは適用しない（外界 grounded のエピソード蒸留のみ）。
- `npm run dream` は従来どおり手動バッチとして残る（同じ `runDream`）。

**残（任意）**: memo_index 同期（`distill` 実行時に `data/notes/` をスキャンして未登録ファイルを upsert）は未実装。

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

**状態:** 視覚は着手（上記「身体・存在感」参照）。残りは未実装。  
**前提:** 視覚はハード不要（Slack 画像 or ファイル源）。ライブ映像・音声入力は外部ハード。

#### センサー側（プリプロセスへの入力）

- **視覚**: 上記「身体・存在感」に移動。**記述文に変換しない**方針に変更（生画像を `image_feed` で直接渡す）。受動の視覚は実装済。
- **音声入力**: ウェイクワード検出 → `user_message` トリガー。STT は挟まず Qwen3-Omni で生音声のまま（上記「音声」）。

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

### 8. 細かい改善・積み残し

- ~~**research 長尺の Slack snippet 化**~~ ✅ 実装済（2026-06-15）: `ARTIFACT_INLINE_MAX`（1200字）超の成果物は `chat.postMessage` の inline でなく `files.uploadV2` の snippet（折りたたみ添付）で投稿＝チャットを流さない。短いものは従来どおり inline。失敗時は inline にフォールバック（`src/cli/slack.ts`）。全文 dump を出さない Phase 1（要約だけ返す）と合わせて完了。
- **符号化ロンダリングの本丸**（🟡 設計済・実装これから）: 作話を招く経路を断つ A/B/C は実装済み。importance は内心更新側へ移した。残る本丸＝「内省が事後に語った内容が、検証なく確信的な記憶として固まる」流れ。**対策設計（お手軽版・2026-06-15）**＝エピソード本文は今のまま（想起無傷）。事実は `turnId` キーの**別記録**（コードが ActionFacts＋発話から機械生成・埋め込まない）にして、**夢が id で引いて裏打ちのある事実から蒸留**（消し込みなし）。固着（意味記憶化）だけ断つ。事実の想起は将来 FW。詳細は [DECISIONS.md](DECISIONS.md) §②符号化側のロンダリング対策。

### 9. embedding サブシステムの骨 🟢（TS だけで作れる・視覚記憶の橋）

**状態:** 未実装。視覚記憶（embedding）の前提。詳細は [ARCH-NEXT.md](ARCH-NEXT.md)「embedding サブシステム」。

- `EmbeddingProvider`（`embedText` / `embedImage`）を切り、既存 `OllamaEmbedClient` を text backend として包む。
- image backend は seam（未設定なら null＝視覚見分けは systematic なのでスキップ）。画像 backend 本体（in-process transformers.js）は後で差す。
- recall 等の呼び出しを窓口経由に寄せる。テキスト経路はテスト可。

---

## 廃止・不採用

| 項目 | 理由 |
|------|------|
| `selfStatus` / `runUntilSettled`（クロスターンループ） | サブエージェント内部ループ（`done=false` 多段ステップ）で原理的に解決可能。暴走リスクの方が高かった。詳細: `docs/archive/deliberation-plan-deprecated.md` |
