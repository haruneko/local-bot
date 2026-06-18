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

**進捗（2026-06-16）**: 受動の視覚 ✅、Slack 画像受信 ✅。＝「目」が通った。**横断 embedding（画像/音/文字を1空間・ImageBind・OFF既定）✅**（下「画像の記憶」）。残り = 能動の見にいく・音声（口/耳）・常駐・ARCH-NEXT 本体。近接ゴールは下「リビング会話トラック」に結晶化した。

### リビング会話トラック（近接ゴール・2026-06-16 結晶化）

北極星: **リビングに Wi-Fiカメラ＋マイク＋スピーカーを置いて、世帯の人と自然に会話できる（ローカルLLM・ローカル完結）**。頭（ターン engine・記憶・想起・omni 視覚）は実装済＝要るのは「口・耳・誰・目・常駐」を物理 I/O に繋ぐこと。ローカルモデルは**実測してから採用**（ImageBind でやった流儀）＝各段に調査タスクがある。🔍調査 / 🔧実装 / 🏁到達点。

- **M-（並走）配置とレイテンシ予算**: 🔍 どこで動かすか（WSL2 か専用機）・音声 I/O ハード・ローカル完結のプライバシー線・**会話テンポの全体レイテンシ予算**（STT＋LLM＋TTS 合計で間が持つか）
- **M0 口（TTS）** 🏁 スピーカーから声で返る: 🔍 ローカル TTS 選定（**VOICEVOX 本命**＝日本語/ローカル/無料・声/レイテンシ/再生経路、Piper 等比較） 🔧 発話→TTS→再生を**出力チャンネル化**（媒体別出し分けの既存思想に乗せる）
- **M1 耳（STT・まず単一話者）** 🏁 話しかけて声で返る: 🔍 faster-whisper / whisper.cpp の**日本語精度＆レイテンシ実測**・マイクハード・VAD（silero-vad 等） 🔧 録音→VAD→STT→`user_message`→既存ターン→TTS ループ
- **M2 話者識別（closed-set）** 🏁 世帯の既知話者を声で区別・正しく帰属: 🔍 話者埋め込み（ECAPA-TDNN / SpeechBrain / pyannote / Resemblyzer）の CPU レイテンシ・enroll 手順・closed-set 精度・unknown 閾値・日本語声 🔧 既知話者を **seed enroll**→embed→最近傍→`speakerId`、**既存 `speakerId`/`users.yaml` seam に供給**（記憶側は無改造）・unknown 話者の扱い
- **M3 目（Wi-Fi カメラ）** 🏁 リビングが見えて反応: 🔍 カメラ選定（ONVIF/RTSP・**LAN 完結プライバシー**）・frame grab（ffmpeg rtsp / ONVIF snapshot）＝`active-eye-camera` 調査を活用 🔧 cam→frame→`image_feed`（既存）・`webcam` actor（能動の見にいく）
- **M4 常駐ループ** 🏁 置きっぱで自然に話せる: 🔍 wake-word（openWakeWord 等）vs 常時 VAD・誤起動・割り込み・常駐運用 🔧 VAD/wake-word→ターン起動・heartbeat 統合・会話の「間」
- **M5（任意・会話 MVP 超）顔**: 誰が在室/誰を見てる（joint attention）。closed-set 顔（ArcFace enroll）。会話には不要・後回し。

依存順: **M-（並走）→ M0 → M1 → M2 → M3 → M4**。M0 が単純で即うれしい。

**音声の方針（2026-06-16 更新）**: 実用路線（Whisper STT＝ユーザー発話の入力／VOICEVOX TTS＝出力／closed-set 話者 ID）を**先**に。Qwen3-Omni（STT/TTS を挟まない一体形）は**重い長期理想**で後の置換候補。**ユーザー発話の STT は「入力＝言語」なので「知覚の言語化を正本にしない」原則と矛盾しない**（image_feed の生画像維持・音の"感じ"は転写しない、で原則は守る）。recognition（同一性）は当面 **closed-set 話者 ID** が本命（ARCH-NEXT「recognition」・open-world/entity 層は別腰）。

### 視覚

1. **受動の視覚** ✅ 実装済（222b8b7）— `image_feed` チャンネルで生画像を言語野へ（文字起こししない）。`src/sensor/frame.ts`・`settings.imageFeedSource`（既定オフ）。現行 chatModel(qwen3.6:35b-a3b) が vision 対応。周辺視野の注釈付き（景色に引っ張られすぎ対策の第一段・要観察）。
2. **Slack 画像受信** ✅ 実装・実機確認済（2026-06-15・`files:read` 付与済）— Slack の添付画像を `image_feed` の出どころにする。`user_message` トリガーに `images?` を足し、orchestrator は「トリガー画像＞ファイルセンサー」で `imageFeed` に入れる。画像だけのメッセージも通す。`url_private` を bot トークンで DL（スコープ未付与・DL 失敗時は黙ってテキストとして続行）。記憶は当面 v1（下記）。
3. **能動の「見にいく」** — `webcam` actor を能動の見る係として実装。カメラを動かした結果の2枚目を `image_feed` に append（`images` は配列なので自然に並ぶ）。＝行動→結果の視覚版。

### 画像の記憶（キャプションを正本にしない・詳細は [ARCH-NEXT.md](ARCH-NEXT.md)「知覚と記憶ループ」）

人間に倣う＝ピクセルを貯めず、**圧縮した非言語の痕跡（embedding）＋意味のラベル**を持ち、思い出す時に作り直す。役割の違う3層：

- **言葉（反応）✅ 実装済**: 内省が「会話で起きたこと＝エバの反応」をエピソードに書く。画像のキャプションではなく彼女の言葉。画像バイトは揮発（とっさの一言と同じ）。
- **embedding（横断＝視覚/聴覚記憶の核）✅ 実装済（OFF既定・2026-06-16）**: 画像/音/文字を1空間（ImageBind・dual-vector）に。画像cueで似た過去を**連想想起**（背景recallに滲む）・text↔画像も双方向。Docker(CPU) HTTP サービス＋別テーブル `episodes_xmodal`＋RRF融合。設計は ARCH-NEXT「横断 embedding」。※identity の同定（「これはポチ」）は**別 faculty＝未実装**（ARCH-NEXT「recognition」・顔/声特化モデル＋entity層が要る）。
- **ピクセル保存（写真アルバム・能動メモ限定）🟢 作れる**: エバが「とっておこう」と決めた画像だけ `data/notes/` に保存しノートから参照。受動エピソードはピクセルを持たない（B' の 記憶 vs 記録）。埋め込み不要・自己完結。

### 音声

→ 近接の実装計画は上「リビング会話トラック」（M0 口/TTS・M1 耳/STT・M2 話者 ID）に集約。**実用路線（Whisper STT＋VOICEVOX TTS＋closed-set 話者 ID）が先**。

- **Qwen3-Omni**（end-to-end omni・30B-A3B）は**長期理想**。音声を文字起こしせず入れ音声で返す＝STT/TTS を挟まない純粋形。要 `ollama pull`（容量大）・VRAM。実用路線で先に喋れるようにしてから置換候補として検討。

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

**memo_index 同期** ✅ 実装済（2026-06-15）: `runDream` が distill 実行時に `data/notes/` をスキャンし、`memo_index` 未登録の本文を upsert（外部から置かれたメモの取り込み・LLM 不要・preview は機械切り）。`memoIndex` 未指定なら何もしない。

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
- **現在の想起**（`runRecall`）は機械 top-2 提示（旧多段ループは 2026-06-18 廃止）。クロスターンのタスク前進はこの手前のステップ

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
- **音声入力**: ウェイクワード/VAD → `user_message` トリガー。当面は **Whisper STT＋closed-set 話者 ID**（リビング会話トラック M1/M2）。omni 生音声は長期理想。

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
- **符号化ロンダリングの本丸** ✅ 実装済（2026-06-15）: 作話を招く経路を断つ A/B/C に加え、②符号化側を実装。エピソード本文は今のまま（想起無傷）。`EpisodeMetadata.groundedFacts`（相手発話＋行動結果・埋め込まない）を機械生成し、**夢が body でなく groundedFacts から蒸留**（消し込みなし）＝固着（意味記憶化）を断つ。事実の想起（具体で引く2本立て）は将来 FW。詳細は [DECISIONS.md](DECISIONS.md) §②符号化側のロンダリング対策。

### 9. embedding サブシステムの骨 ✅ 横断 embedding で達成（2026-06-16）

**状態:** 横断 embedding（ImageBind・OFF既定）の実装で実質達成。詳細は [ARCH-NEXT.md](ARCH-NEXT.md)「横断 embedding の設計」。

- text は既存 `OllamaEmbedClient`（ruri-v3。2026-06-17 に nomic から変更・768 次元は不変）据え置き、横断は `XmodalEmbedder`（ImageBind・画像/音/文字を1空間）＝差し替え可能 backend の窓口。
- 落ちてる/未設定なら null＝degrade（systematic なのでスキップ）。別テーブル `episodes_xmodal`＋RRF 融合。
- ※当初案の「in-process transformers.js で CLIP」は ImageBind（PyTorch・Docker HTTP）に置換。identity 同定（顔/声）は別 faculty（recognition・未実装）。

---

## プロバイダ移行（Ollama → 外部 API / Vertex AI）

**状態:** 未着手・調査済み。詳細スコープは [docs/research/vertex-migration-scoping-2026-06-18.md](research/vertex-migration-scoping-2026-06-18.md)。

LLM は `LlmClient` アダプタ越しなので**チャットは `VertexLlmClient` を1クラス足せば呼び出し側無改修**。ただし要対応：
- **アダプタの漏れ**: `think`/`numCtx` が client config を貫通／**埋め込みに抽象が無い**（stores が具象 `OllamaEmbedClient` 直依存・8箇所）。
- **地雷＝埋め込み移行**: 既定 ruri-v3（日本語ローカル・768次元・非対称タスク接頭辞）→ Vertex は別モデル・別次元（例 gemini-embedding 3072）。**全テーブル再生成必須**＋接頭辞→`task_type` への思想転換（`embedPrefixFor` は Vertex に不適）＋`recallDistance` 閾値の測り直し。横断 ImageBind は独立で無改修。
- **構造化出力**: 全 actor/role が `format`(JSON Schema) 依存。Gemini=`responseSchema`へ変換層／Claude on Vertex=tool-use。`tryParseJsonWithSchema` のフォールバックが強く裸 JSON でも実用上通る公算。
- **横断**: 認証 ADC 追加・settings に `llmProvider` キー・リトライに `RESOURCE_EXHAUSTED` 追加・`num_predict:-1` の読み替え。
- 使い分け: Gemini=構造化ネイティブ・安い／Claude on Vertex=日本語品質・think不要だが高コスト。role/actor 単位のモデル分離機構が既にあるので併用可。

## 廃止・不採用

| 項目 | 理由 |
|------|------|
| `selfStatus` / `runUntilSettled`（クロスターンループ） | サブエージェント内部ループ（`done=false` 多段ステップ）で原理的に解決可能。暴走リスクの方が高かった。詳細: `docs/archive/deliberation-plan-deprecated.md` |
