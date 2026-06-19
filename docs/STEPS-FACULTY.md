# STEPS-FACULTY — 計画を扱う faculty の設計

計画（`data/steps/<id>.json`）を「思い出す・掴む・進める・しまう」ための仕組み。memo faculty（[MEMO-TREE.md](MEMO-TREE.md)）の計画版にあたる。設計の経緯と論拠は [DECISIONS.md](DECISIONS.md) §集中モード（「受け入れ判定（実行後）」「計画実行の3層構造」）。

## 全体像：係（役割が違う・混ぜない）

机の上の「プロジェクト・バインダー」で例える。

| 係 | 正体 | やること | いつ動く | 状態 |
|---|---|---|---|---|
| **手配り** dispatcher | LLM 判断（集中のみ） | current タスクを**どの手で進めるか**選ぶ（synthesize/webSearch/urlBrowse/memo） | 集中の実行時 | 実装済み |
| **進行係** steps processor | 機械（**実行のあと**の受け入れ判定） | いま終えた行動の**実結果**を見て、終わった項目に✓・次へ・全✓なら完了畳み | 集中中・毎ターン自動 | 実装済み |
| **手** steps actor | LLM 判断のアクター | どのページを扱うか・作る/始める/しまう/手で直す（管理） | 対話・静穏で理由があるとき | 実装済み |
| **目覚まし** schedule/cron | 機械（時計） | 時刻でページを出す（毎朝/予定） | 定期・予定時刻 | 暫定（要検証） |

**不変条件**: **やる人（doer）と認める人（受け入れ判定）は別人格**（やった本人に合否を出させない＝作話防止）。日々の milestone ✓は進行係（受け入れ判定）が自動でやるので、手（steps actor）はそれを起動理由にしない。**手の管理は対話・静穏でだけ**（集中は実行に専念）。

---

## 集中の実行ループ（dispatcher ＋ 受け入れ判定）

「ターンの頭で計画しない／結果を受けて動く」に揃えた、集中1ターンの流れ：

```
集中（current タスクあり）：
  ① dispatcher が current タスクに合う手を1つ選ぶ（調べる→webSearch／書く→synthesize…）
  ② 選ばれた手だけ実行（doer）
  ③ 受け入れ判定（実行のあと）：今回の行動の実結果＋成果物で「current は実際にやれたか」を狭い yes/no で判定
     ＝doer とは別人格。失敗・空振りなら進めない（偽の done を作らない＝作話防止）
  ④ 機械が✓・current 前進・全✓なら完了畳み（focus を手放す）
  発話は任意（理由があるときだけ）
対話・静穏：従来の汎用 activator（反応モード）＋手（steps actor）の管理
```

- **頭では判定しない**＝current は前ターンの受け入れ判定が置いたもの。doer はそれに沿って動く。
- 受け入れ判定の入力は「今回作った中身（synthesize の本文・webSearch のデータ）」＋「成果物(works)全文」。全体を見ないと判定できないマイルストーン（通しで整える等）も works 全文で判定できる。
- **完了畳み**: 達成（全✓）した段取りは「完了」として閉じ、再判定・再 activate しない。

詳細は DECISIONS §集中モード。

---

## steps actor（手＝計画を掴む効果器）

memo actor（探す→全文ロード→op）と同じ「効果器」の形。ただし steps は数が少ないので**探す＝一覧を見るだけ**でよい（vector locate は不要）。

### 何が見える（入力）

- **steps 一覧（バインダーの目次）**: 各 steps の id・タイトル・状態・current milestone。`listSteps()` を新設（`stepsDir()` を読む・done/retired を畳んで提示）。
- **いま surface している steps**: recall（連想）や schedule（時刻）が浮かべたもの。
- **いまの focusSteps・関心事(concern)・直近の文脈（mini-context）**。

### 何ができる（op）

どの op も **対象 steps を `stepsId` で指定**（省略時 = いまの focusSteps）。＝**今のページ以外も触れる**のが今までとの違い。

| op | 意味（バインダーで言うと） | 主なフィールド |
|---|---|---|
| `view` | ページを**読んで報告するだけ**（始めない・focus 変えない）。stepsId 無し＝やり残し一覧、有り＝その計画の詳細 | `stepsId`(任意) |
| `new_goal` | 新しいプロジェクトのページを足す | `title` `goal` `milestones[]` `activate` |
| `activate` | そのページを机に出して**開始/再開**（focusSteps にして集中へ） | `stepsId` |
| `shelve` | 机から下げる（**棚に戻す・捨てない・あとで再開できる**） | `stepsId` |
| `retire` | **見限る**（諦め・自動復帰しない） | `stepsId` |
| `complete` / `reopen` | 項目を手で✓/戻す（普段は進行係が自動・手動上書き用） | `stepsId` `id`(milestone) |
| `set_current` | 取り組む項目を変える | `stepsId` `id`(milestone) |
| `add_milestone` | 項目を足す | `stepsId` `text` |
| `log` | 「〜した」を履歴に書く（過去形の事実のみ） | `stepsId` `text` |
| `noop` | 何もしない | — |

構造の更新は `applyStepsOp`（純関数）が決定的に行う。LLM は op を1つ出すだけ（文書は書かない・強制ギプス）。

### 会話ループ：報告（view）→ 取りかかる（activate）（2026-06-19）

「やり残しある？」のような**報告・確認・言及には `view`**（始めない・focus 変えない）、「これ進めて／再開して」のような**取りかかる意図のときだけ `activate`**、と使い分ける（STEPS_SYSTEM で誘導）。これで二段会話が成立する：

```
HAL「やり残しある？」       → view(stepsId 無し) → backlog 一覧を言語野へ → エバが列挙
HAL「じゃあ ESP32 進めて」   → activate(esp32)   → focusSteps 起立 → 集中
HAL「あの歌詞どうなってる？」 → view(歌詞)         → その計画の詳細を報告
```

実機で観測した不具合の対策＝**「計画立てたっけ？」に対し activate して勝手に始めてしまう**（view が無く noop か activate の二択しか無かった）。view を足し、報告と着手を分けた。view は読み取り専用＝保存も focus 変更もしない（facts.action="view"・言語野が body を読んで答える）。

### 「開始」「棚上げ」「見限り」の区別（重要）

- `activate(stepsId)` → `focusSteps = stepsId` → 次の State 導出で**集中に入る**。明示的な「これを始める」＝「作っただけで集中に固定しない（うっかり集中の防止）」と整合。
- **shelve と retire は別物**:
  - `shelve` = **一時停止**。focusSteps から外すが backlog に active のまま残り、後で `activate` で再開できる。エバの**意図的な**「今はここまで」。
  - `retire` = **見限り**。`retired:true`。backlog の surface 対象から外れ、**自動復帰しない**。
  - （参考）疲労 `focusStreak` は自動で focusSteps を手放すが goal は残す＝shelve に近い自動版。進捗停滞 `focusStall` は自動 retire。どちらも**自動**。shelve/retire op は**エバの意志**版。

### `new_goal` は意図で2通り（合意）

- **今からやる**（「よし歌詞書こう」）→ `new_goal` ＋ `activate:true` ＝作って即開始（集中へ）。
- **後のために積む**（「明日講演会だから前に一言送っとこ」）→ `new_goal`（`activate:false`・既定）＝**ページを足すだけ**。backlog に置かれ、後で schedule（時刻）や recall（連想）が surface し、`activate` で掴む。

普通のタスク積み（後者）が日常運用の本体。前者は「すぐ取りかかる」ショートカット。

**重複防止（2026-06-19）**: new_goal の前に、提案タイトル＋goal を**既存の全段取り（完了済み・見限り含む）**と字句近さ（bigram Dice>0.5）で照合し、似たものがあれば作らない（notAttempted）。達成後に関心事が残って同じ段取りを作り直す重複生成を断つ＝memo の recall 認識による重複防止と同型。

### memo との境界（2026-06-19）

**多段で取り組む「目標そのもの」は steps の領分／単発の事実・在庫・リスト・素材の記録は memo。** 実機で「過去の話題が steps に乗らず memo に流れて漂流」（既存 steps を認識せず memo が `goals/*.md` に技術メモを書く）を観測したため、両 criteria に境界を明記し、**memo は `goals/`（steps 所有の派生ビュー）に書かない**（書くと次の renderSteps で上書き消失・取り合いになる）＝memo の locate からも `goals/` を除外し、書き込み先が `goals/` なら no-op で steps に譲る。

### いつ動く（criteria）

- 相手が「目標を立てたい / 始めたい / やめたい / 変えたい」と言ったとき。
- **エバ自身が独り言で**「あれ再開しよう」「明日のために予定足しとこ」と思ったとき（**自己起点を開ける**＝従来の相手寄り criteria を緩める）。
- idle で backlog / schedule から steps が surface し、掴む価値があるとき。
- ❌ 日々の milestone ✓だけ＝進行係（processor）の仕事なので起動しない。

---

## surface（思い出す）— **idle 限定**（2026-06-19 確定）

steps を「常時の背景 recall」に混ぜると**引っ張られすぎる**＝過剰発火でタスク固執（タコ耳）が復活する。理由: steps は命令形（「やれ」）で行動への引力が episode より強い／ゴールは広くマッチする／recall は毎ターン。会話中も todo に気を取られる人になる。人間は会話中ずっと todo に引っ張られない＝**強くゲートされている**。

なので **steps の surface は普通の recall とは別扱いにし、idle（静穏）でだけ起こす**：

- **常時 recall には steps を混ぜない**（過剰引力の元を断つ）。topical な連想 steps recall（`steps_index` を背景 recall に載せる案）は欲しくなってから高閾値で慎重に、として**当面やらない**。
- **idle（静穏 heartbeat）でだけ surface**＝会話中は引っ張られない。「手が空いた→何しよう」。
- **drive ゲート／間引き**＝idle のたび全部でなく、時々・強いものだけ（毎 idle で必ず拾うと作業マシン化＝非人間的）。

### v1 の2本（どちらも idle で・過剰に引っ張らない）

1. **idle backlog surface**（本体）: idle のとき backlog（未完 steps・recency 順）を文脈に出し、**「手」（steps actor）が activate するか判断**する＝選択は中央スケジューラでなく観測駆動（哲学）。charge 用の steps importance フィールドは持たず、提示順（recency）＋ LLM 判断で v1。＝普通にタスクを積む/思い出して掴む、が固い本体。
2. **schedule（時刻・暫定）**: steps に任意の時刻アンカー（一回きり `at` / 繰り返し `recur`）。idle の「期限チェック」で時計と照合し来ていれば surface（一回きりは消費・繰り返しは1周期1回）。時刻＝客観条件＝機械ゲート許容枠内。
   - **割り切り（確定）**: チェックは idle のみ＝**会話中はスケジュールが発火しない**。会話を終えて手が空いた次の idle で気づく＝むしろ人間的。最初はこれで可。
   - ⚠️ schedule はこの設計のまま完璧には動かない可能性あり（「やってみてから直す」前提）。

## ドライブ／自発性との関係（Tier 2）

「手」＋「surface（idle backlog/schedule）」が揃うと、idle で steps が浮かぶ→`activate` で掴む、という**自発の点火**ができる。これが embodied-claude（ここね）比で不足していた「自発的に動く」の土台。中央スケジューラ（ジャッジ復活＝哲学違反）は作らず、**surface は idle 限定・選択は steps actor の判断**で回す。DECISIONS §集中モード「計画実行の3層構造」Tier 2。

## 実装状況

- 手配り（dispatcher・`src/roles/steps-dispatch.ts`）: **実装済み（2026-06-19）**。集中で current タスクに合う手を1つ選ぶ。
- 進行係（受け入れ判定・`src/roles/steps-processor.ts`）: **実装済み**。**実行のあと**に、今回の実結果＋成果物で判定（旧「前判定」から移動）。doer⊥判定。
- 手（steps actor）: **実装済み**。`listSteps()`／op に `stepsId` target＋`view`/`activate`/`shelve`/`retire`＋`new_goal` の `activate` フラグ＋重複防止／自己起点 criteria。facts.action で orchestrator が focusSteps 制御。集中の actor からは外す（管理は対話・静穏）。
- 完了畳み: **実装済み**（達成で閉じる・再判定/再 activate しない）。
- 目覚まし（schedule/cron）: 暫定設計・未実装。
- idle backlog surface: 実装済みだが kill-switch `STEPS_IDLE_SURFACE=off` で**現在 OFF**（重複生成/研究系の確認が固まるまで）。
- recall に steps を入れる（steps_index）: 当面やらない（過剰引力）。
