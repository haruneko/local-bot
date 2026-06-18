# コード構造の自己診断 — 2026-06-18

対象: `/home/shuraba_p/projects/local-bot`（src/ 全体）。正本は `CLAUDE.md` と `docs/`（CONCEPT / SPEC / DECISIONS / ACTION-DESIGN / ARCH-NEXT / MEMO-TREE / ROADMAP）。
方法: 読み取り専用。`npx tsc --noEmit`（PASS）・`npx vitest run`（**327 件中 1 件 FAIL**）を実行。アプリ本体（say/dev/heartbeat/dream）は起動していない。

総評: 設計思想（分離脳・単一ジャッジ無し・TurnContext 単一・記憶4層・強制ギプス）はコードによく落ちている。`any`/非null アサーションはほぼ皆無、循環依存・god class も無い（最大は `turn.ts` 877 行だが責務は明確に private メソッドへ分割済み）。**最大の問題は「実装が docs を追い越したのに docs/SPEC/テストが追従していない」乖離**で、致命的なバグではなく「正本の信頼性が落ちている」種類の負債が中心。

---

## 1. 設計と実装の乖離

### 【高】SPEC が約束する `nextState` が実装から完全消滅している（State は機械導出へ移行済み）
- SPEC §4.2 step 3「language-agent → … + NEXT_STATE 出力 → `ctx.nextState` を設定」、step 6「State 更新 `state = ctx.nextState`」、§7.3 出力スキーマ `{ speech, nextState }`、DECISIONS §エージェント出力（line 27）。
- 実装: `LanguageOutput = { speech: string }`（`src/roles/language-faculty.ts:19`）。スキーマも `{ speech }` のみ（`:21-23`）。State は `turn.ts:445-450` で **トリガーと focusPlan から機械導出**（user_message→対話／focusPlan→集中／else→静穏）。`ctx.nextState` というフィールドは TurnContext に存在しない。
- 根拠: DECISIONS §集中モード（line 444）「state は制御プレーン＝観測事実から導出する（言語野は宣言しない）」が**正しい現状**。つまり SPEC §4.2/§7.3 と DECISIONS §エージェント出力（line 27）が**古い**。parser はわざわざ `nextState` を「漏れ出た旧出力の痕跡」として末尾除去している（`language-faculty.ts:43`, `salvageSpeech`）＝旧仕様の化石処理。
- 問題: SPEC は「テストの根拠」と CLAUDE.md / SPEC 冒頭が明言しているのに、その MUST が実装と矛盾。新規実装者が SPEC を信じると壊す。

### 【高】`recall` 行動の LLM 要約（`summarizeRecallActionHits` / `RECALL_ACTION_SYSTEM`）が実装に存在しない
- DECISIONS §想起グラデーション（line 203）「`recall` 行動のヒット要約も LLM（`summarizeRecallActionHits`）。パース失敗時のみ機械フォールバック」。DECISIONS §作話③（line 463）は `RECALL_ACTION_SYSTEM` を偽前提作話の**「主犯」修正点**として詳述。
- 実装: `runRecall`（`src/roles/recall.ts:9-42`）は **LLM を一切呼ばず**、距離フィルタ後の上位2件の本文を機械的に bullets にするだけ（`:37-39`）。`grep` でも `summarizeRecallActionHits` / `RECALL_ACTION_SYSTEM` はソースに存在しない。
- 評価: 機械化は作話耐性の観点ではむしろ安全（要約で前提に寄せる経路が消える）。だが DECISIONS §作話③が「実装済」と謳う**主犯対策の機構そのものが現コードに無い**＝作話対策の正本が現実を反映していない。少なくとも DECISIONS にカットオーバー記録が要る。

### 【中】SPEC §5.3 の `ActionFacts` 型定義が実コードと不一致
- SPEC §5.3（line 109-117）: `synthesize` kind が無い・`research` に `summary` フィールドが無い。
- 実装: `src/action/facts.ts` に `synthesize`（`:9`）あり、`research` は `summary` 込み（`:7`）。SPEC が古い。

### 【中】DECISIONS が「温存」と書いた `runRecallLoop` は存在しない（名前と実体の乖離）
- DECISIONS §記憶 faculty（line 504）「run 関数 `runRecallLoop`/`runForget` は温存」。
- 実装: 関数名は `runRecall`（`recall.ts:9`・loop ではない単発）。`runForget` は存在（`roles/forget.ts:17`）。docs の関数名が誤り。

### 【低】heartbeat 言語野の温度が docs と食い違い
- DECISIONS §ハートビート言語野のフォーマット統一（line 352）「temperature は両トリガーで 0.8 に統一」。
- 実装: 既定 0.6（`language-faculty.ts:182`、コメントは「屋久島プローブで 0.6 に決定」と別経緯を記す）。docs が古い。実害なし。

### 確認できた「乖離していない」不変条件（裏取り済み・健全）
- **1ターン=1 TurnContext**: `turn.ts` は単一 `ctx` を再代入で引き回し、終了時 `this.turnContext = null`（`:498`）。T-T01 でテスト済。
- **ロールごとに入力フォーマットを変えない**: 全ロールが `memorySnapshot(ctx)`/`buildActorContext` 経由（`turn-context.ts:255`）。
- **memo 本文を LLM 要約しない**: `action/present.ts` の短縮は表示用 preview のみ。本文要約経路なし。
- **memo_write 成功時に episodes へ直書きしない**: `persistReflection` のみが `episodes.append`。memo は memo_index へ。
- **キーワード直行ルーティング禁止**: 起動は全 actor が LLM `activate()`（`memory.ts:43` 等）。機械ゲートは recall=常時・視覚=画像有無・distill=静穏idle のみ（DECISIONS で許容済の客観条件）。
- **元データ削除禁止**: フィルタは `slice`/距離閾値で量を絞るだけ。LanceDB/state.json を消す経路なし。

---

## 2. 結合と責務

### 【中】webSearch / urlBrowse の実行が旧「カテゴリ・サブエージェント」機構の上に残っている
- SPEC §5「カテゴリ・サブエージェントの束ねは廃止（dead-in-prod も削除済み）」。
- 実装: `webSearchActor` / `urlBrowseActor` は `runResearchSubagent`（`src/roles/subagent.ts:147`）を呼び、内部で `SUBAGENT_STEP_SYSTEM`（"カテゴリ内のツールを1つ選び実行"）＋ `MAX_SUBAGENT_STEPS=3` の**マルチステップ・ツール選択ループ**を回す。実際には各 actor が単一ツール（`["web_search"]`/`["browse_url"]`）しか渡さない（`web-search.ts:20,38`）ので、276 行のカテゴリ選択機構は**1ツール用にはオーバーキル**。
- 評価: dead ではない（本番経路）。だが「カテゴリ束ね廃止」という設計宣言と、実体（カテゴリ語彙＋複数ツール選択ループ）がズレている。単一ツール実行に薄くできる余地（責務の過剰）。

### 【低】`turn.ts` が横断（xmodal）・視覚・聴覚・distill まで抱えて肥大化
- `turn.ts` 877 行。`run()` 本体は約 215 行（`:288-503`）で、横断 RRF 融合（`fuseXmodalRecall` 65行）・横断ベクトル符号化・focus 3段制御・自発 distill が全部 orchestrator に同居。
- 個々は private メソッド分割済みで god method ではないが、横断（OFF 既定の実験機能）が本線オーケストレータに編み込まれており、`run()` の認知負荷が高い。preprocess（想起）周りは `recallMemories`+`fuseXmodalRecall` で 160 行超。complexity ホットスポット（§4 参照）。

### 健全な点
- actor/role/orchestrator の境界は概ね明確: actor=`activate`+`run`（薄いアダプタ）、role=実処理（`runRecall`/`runForget`/`runResearchSubagent`/`generateDialogueSpeech`）、orchestrator=フェーズ統括。
- 循環依存・相互 import の輪は検出されず。`tsc --noEmit` クリーン。

---

## 3. 重複・デッドコード

- **旧実装の残骸はおおむね一掃済み**（裏取り）: `searxng` 参照ゼロ・`TurnBrief`/`VolatileContext` ゼロ・`src/actors/recall.ts`/`forget.ts`（薄ラッパ）削除済（registry は `memory`/`memo`/`webSearch`/`urlBrowse`/`plan`/`synthesize` の6本のみ・`actors/registry.ts`）。
- **`vague` は意図通り温存**: presentation 段からは廃止され、`distanceToRelevance` の正規化上限（`recall/distance.ts:166-172`）としてのみ残る＝DECISIONS と一致。デッドではない。
- **`remember` は履歴用に温存**: `EpisodeSource "remember"`（`types.ts:37`）と `present.ts` の表示分岐＝SPEC §5.1 通り。能動 actor としては不在（正しい）。
- 【低】**`webcam` の幽霊エントリ**: `ActorName` と `DEFAULT_ACTOR_CHANNELS`（`settings.ts:45`）に `webcam` があるが registry に実体なし。`stateConfig` で誤って有効化すると `getActor("webcam")` が `undefined` を返し `runActorPool` で静かにスキップ（`turn.ts:711-712,724-725`）＝無害だが**沈黙する設定トラップ**。SPEC §5.1 は「未実装」と明記しているので意図的だが、未実装 actor を有効化したら警告したい。
- 【低】`formatActionSummary`（`present.ts:17-42`）は `formatActionFactContent`/`languageSuccessLine` と機能が重複気味。呼び出し元の有無は要確認（表示系の3関数が op 別 switch を各々持ち、kind 追加時に3箇所メンテが要る重複）。

---

## 4. 複雑度ホットスポット

- 【中】`src/orchestrator/turn.ts` `run()`（`:288-503`）＋ `recallMemories`（`:506-599`）＋ `fuseXmodalRecall`（`:607-671`）。focus 3段制御の分岐（入口 `:411`／疲労 `:418`／停滞リセット `:425`／導出 `:445`／streak `:452`／卒業 `:454`）が `run()` 末尾に直列に並び、状態フィールド（focusPlan/focusStreak/focusStall/focusBaseline）への副作用が散在。pure 部分（`evaluateFocusGraduation`）は切り出し済だが、**streak/cutoff/state 導出は orchestrator にベタ書き**で、ここがテスト空白（§6）と重なる最もリスキーな箇所。
- 【低】`src/action/present.ts`（321 行）: op 別 switch が `formatActionSummary`/`formatActionFactContent`/`languageSuccessLine`/`languageEmptyLine`/`languageErrorLine` の5関数に分散。各 kind 追加で5箇所更新。網羅は効いている（switch の exhaustiveness）が変更コスト高。
- 深いネスト・分岐過多は他に顕著な箇所なし。

---

## 5. 型・エラー処理の穴

- **`any`/非null アサーション: 実質ゼロ**（`grep` で `: any`/`as any` ヒットなし。`!` は eval-retrieval 2・turn 1・semantic 1 のみ、いずれもローカル確証あり）。良好。
- 【低】**inner-state の最終フォールバックが生 LLM 出力を affect に流す**: `parseAffectAndConcern`（`inner-state.ts:104-105`）。`tryParseJsonWithSchema`（think 除去込み）→ 素 `JSON.parse` と二段で受けるが、両方失敗時 `{ affect: raw.trim(), … }` と**未除去の生出力（`<think>` や壊れ JSON 断片を含みうる）をそのまま affect に格納**＝持ち越し state を汚染しうる。language 側は同種ケースで沈黙にフォールバックする（`language-faculty.ts:83`）のと非対称。少なくとも `stripThinkBlocks` を通すべき。
- 握りつぶし `catch {}` は多数あるが、確認した範囲（xmodal best-effort `turn.ts:695`/`xmodal.ts:75`、persistXmodalVector、tree フォールバック）はいずれも**意図的な best-effort でコメントあり**＝設計通り。
- parse 失敗の扱いは堅牢: activate は2回リトライ→`null`（起動しない）、language は多段救出→沈黙、subagent はパース失敗を `actionFailed`（偽成功にしない・DECISIONS §ツール引数の検証 通り）。良好。

---

## 6. テストの空白

### 【高】テスト1件が実装と矛盾して FAIL 中（`web-search-activate.test.ts` T-WS04）
- `tests/web-search-activate.test.ts:41-47` が webSearch activate の system プロンプトに `"ユーザー"`・`"内心"`（旧2段階「指示ベース・内心ベース」文言）を含むと assert。
- 実装は DECISIONS §webSearch 原則化（line 339・2026-06-14）で**単一の「外界の事実が要るか」テストへ畳んだ**ため、その文言が消え **FAIL**。SPEC §11 の T-WS04/T-WS05 の説明文も旧2段階のまま。
- ＝コードバグではなく**設計変更にテストと SPEC が追従していない**。CI を通すなら T-WS04 を新プロンプト準拠（"外界の事実"/`active:false` 条件）へ書き換え、SPEC §11 を更新すべき。

### 【高】State 機械導出（新・制御プレーンの核）にテストが無い
- `turn.ts:445-450` の state 導出（trigger→対話／focusPlan→集中／else→静穏）、`:452` の focusStreak 加減算、`:418` の MAX_FOCUS_STREAK 切れ、`:425` の plan 乗換時 stall リセット — いずれも**直接の単体テストなし**。`focus.test.ts` は pure `evaluateFocusGraduation` のみ。`turn.test.ts:387` は「集中 heartbeat で distill 呼ばない」を見るが state 導出自体は assert しない。
- SPEC §2「`NEXT_STATE` は検証せず代入」は今や死語で、新導出ロジックを縛る MUST がそもそも SPEC に無い（SPEC 側も穴）。集中の暴走防止という最重要安全機構がテスト無しで orchestrator にベタ書き。

### 【中】テストの fake が旧 `nextState` を出し続けている（無害だが腐敗の兆候）
- `turn.test.ts:22-23`・`language-faculty.test.ts` 多数の fake が `{"speech":...,"nextState":...}` を返す。parser が黙って捨てるので通るが、テストが旧スキーマを温存＝SPEC §7.3 の化石と呼応。

### 健全な点
- SPEC §11 の生きた ID は概ね実在（T-T01/T-W01/T-IS01-05/T-WS01-03/T-I01-04 相当・introspection は ID 無しだが振る舞いカバー）。記憶系・recall 距離・memo tree・focus pure・parse-json は手厚い。

---

## 優先順位サマリ

| # | 重大度 | 指摘 | 場所 | 根拠 |
|---|--------|------|------|------|
| 1 | 高 | テスト T-WS04 が FAIL（旧 webSearch プロンプト文言を assert・設計変更に未追従） | `tests/web-search-activate.test.ts:41-47` | DECISIONS §webSearch 原則化 line 339 |
| 2 | 高 | SPEC の `nextState`/NEXT_STATE が実装から消滅・State は機械導出へ移行済 | `language-faculty.ts:19`, `turn.ts:445-450` / SPEC §4.2,§7.3, DECISIONS line 27 | SPEC が「テストの根拠」と矛盾 |
| 3 | 高 | recall 行動の LLM 要約機構（`summarizeRecallActionHits`/`RECALL_ACTION_SYSTEM`）が実コードに無い | `roles/recall.ts:37-39` / DECISIONS line 203,463 | 作話対策「主犯」の正本が現実と不一致 |
| 4 | 高 | State 機械導出・focusStreak・MAX_FOCUS_STREAK にテスト空白（暴走防止の核） | `turn.ts:418,425,445-452`（テスト無し） | 安全機構が無検証 |
| 5 | 中 | webSearch/urlBrowse が旧カテゴリ・サブエージェント機構の上に残存（単一ツールにオーバーキル） | `roles/subagent.ts`, `actors/web-search.ts` | SPEC §5「束ね廃止」と実体のズレ |
| 6 | 中 | SPEC §5.3 ActionFacts 型が実コードと不一致（synthesize 欠落・research.summary 欠落） | SPEC §5.3 vs `action/facts.ts:7,9` | SPEC が古い |
| 7 | 中 | inner-state 最終フォールバックが生 LLM 出力（think 含みうる）を affect に格納 | `inner-state.ts:104-105` | 持ち越し state 汚染リスク |
| 8 | 低 | DECISIONS の関数名 `runRecallLoop` が実体（`runRecall`）と不一致 | DECISIONS line 504 | docs 誤記 |
| 9 | 低 | heartbeat 言語野温度: docs 0.8 / 実装 0.6 | DECISIONS line 352 vs `language-faculty.ts:182` | docs 古い・実害なし |
| 10 | 低 | `webcam` 幽霊エントリ（型・channels にあり registry に無し）＝有効化すると沈黙スキップ | `settings.ts:45`, `turn.ts:711-712` | 設定トラップ |
| 11 | 低 | `turn.ts` 肥大（横断・focus 制御が本線に編み込み・preprocess 160 行超） | `turn.ts:288-671` | 複雑度ホットスポット |
| 12 | 低 | 表示系 op 別 switch が3〜5関数に重複（kind 追加コスト高） | `action/present.ts` | 保守性 |

注: 1〜4 が実害/信頼性の本丸。特に #1 は今すぐ CI を落とすので最優先。#2/#3 は「設計が前進した結果の docs 腐敗」で、コードは安全側に動いているが**正本（SPEC/DECISIONS）の信頼性が下がっている**のが本質的リスク。
