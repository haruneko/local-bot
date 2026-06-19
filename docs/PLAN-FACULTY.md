# PLAN-FACULTY — 計画を扱う faculty の設計

計画（`data/plans/<id>.json`）を「思い出す・掴む・進める・しまう」ための仕組み。memo faculty（[MEMO-TREE.md](MEMO-TREE.md)）の計画版にあたる。設計の経緯と論拠は [DECISIONS.md](DECISIONS.md) §集中モード（「plan processor（前判定）」「計画実行の3層構造」）。

## 全体像：3つの係（役割が違う・混ぜない）

机の上の「プロジェクト・バインダー」で例える。

| 係 | 正体 | やること | いつ動く | 状態 |
|---|---|---|---|---|
| **進行係** plan processor | 機械（毎ターン頭の前判定） | いま開いてるページの終わった項目に✓を入れて次へ進める | 集中中・毎ターン自動 | 実装済み |
| **手** plan actor | LLM 判断のアクター | どのページを扱うか・作る/始める/しまう/手で直す | 理由があるとき | 本書で設計 |
| **目覚まし** schedule/cron | 機械（時計） | 時刻でページを出す（毎朝/予定） | 定期・予定時刻 | 暫定（要検証） |

**不変条件**: 進行係は「いまのページを前に進める」だけ。**どのページを扱うか・作る/しまうは"手"の仕事**。日々の milestone ✓は進行係が自動でやるので、手（plan actor）はそれを起動理由にしない。

---

## plan processor（進行係・実装済み）

集中の毎ターン頭で、成果物(works)と計画を突き合わせ、current milestone から前へ「達成された？」を狭い yes/no で判定→機械が✓・current 前進・全✓なら締める。詳細は DECISIONS §集中モード「plan processor（前判定）」。本書では「手」と区別するためだけに触れる。

---

## plan actor（手＝計画を掴む効果器）

memo actor（探す→全文ロード→op）と同じ「効果器」の形。ただし plan は数が少ないので**探す＝一覧を見るだけ**でよい（vector locate は不要）。

### 何が見える（入力）

- **plan 一覧（バインダーの目次）**: 各 plan の id・タイトル・状態・current milestone。`listPlans()` を新設（`plansDir()` を読む・done/retired を畳んで提示）。
- **いま surface している plan**: recall（連想）や schedule（時刻）が浮かべたもの。
- **いまの focusPlan・関心事(concern)・直近の文脈（mini-context）**。

### 何ができる（op）

どの op も **対象 plan を `planId` で指定**（省略時 = いまの focusPlan）。＝**今のページ以外も触れる**のが今までとの違い。

| op | 意味（バインダーで言うと） | 主なフィールド |
|---|---|---|
| `view` | ページを**読んで報告するだけ**（始めない・focus 変えない）。planId 無し＝やり残し一覧、有り＝その計画の詳細 | `planId`(任意) |
| `new_goal` | 新しいプロジェクトのページを足す | `title` `goal` `milestones[]` `activate` |
| `activate` | そのページを机に出して**開始/再開**（focusPlan にして集中へ） | `planId` |
| `shelve` | 机から下げる（**棚に戻す・捨てない・あとで再開できる**） | `planId` |
| `retire` | **見限る**（諦め・自動復帰しない） | `planId` |
| `complete` / `reopen` | 項目を手で✓/戻す（普段は進行係が自動・手動上書き用） | `planId` `id`(milestone) |
| `set_current` | 取り組む項目を変える | `planId` `id`(milestone) |
| `add_milestone` | 項目を足す | `planId` `text` |
| `log` | 「〜した」を履歴に書く（過去形の事実のみ） | `planId` `text` |
| `noop` | 何もしない | — |

構造の更新は `applyPlanOp`（純関数）が決定的に行う。LLM は op を1つ出すだけ（文書は書かない・強制ギプス）。

### 会話ループ：報告（view）→ 取りかかる（activate）（2026-06-19）

「やり残しある？」のような**報告・確認・言及には `view`**（始めない・focus 変えない）、「これ進めて／再開して」のような**取りかかる意図のときだけ `activate`**、と使い分ける（PLAN_SYSTEM で誘導）。これで二段会話が成立する：

```
HAL「やり残しある？」       → view(planId 無し) → backlog 一覧を言語野へ → エバが列挙
HAL「じゃあ ESP32 進めて」   → activate(esp32)   → focusPlan 起立 → 集中
HAL「あの歌詞どうなってる？」 → view(歌詞)         → その計画の詳細を報告
```

実機で観測した不具合の対策＝**「計画立てたっけ？」に対し activate して勝手に始めてしまう**（view が無く noop か activate の二択しか無かった）。view を足し、報告と着手を分けた。view は読み取り専用＝保存も focus 変更もしない（facts.action="view"・言語野が body を読んで答える）。

### 「開始」「棚上げ」「見限り」の区別（重要）

- `activate(planId)` → `focusPlan = planId` → 次の State 導出で**集中に入る**。明示的な「これを始める」＝「作っただけで集中に固定しない（うっかり集中の防止）」と整合。
- **shelve と retire は別物**:
  - `shelve` = **一時停止**。focusPlan から外すが backlog に active のまま残り、後で `activate` で再開できる。エバの**意図的な**「今はここまで」。
  - `retire` = **見限り**。`retired:true`。backlog の surface 対象から外れ、**自動復帰しない**。
  - （参考）疲労 `focusStreak` は自動で focusPlan を手放すが goal は残す＝shelve に近い自動版。進捗停滞 `focusStall` は自動 retire。どちらも**自動**。shelve/retire op は**エバの意志**版。

### `new_goal` は意図で2通り（合意）

- **今からやる**（「よし歌詞書こう」）→ `new_goal` ＋ `activate:true` ＝作って即開始（集中へ）。
- **後のために積む**（「明日講演会だから前に一言送っとこ」）→ `new_goal`（`activate:false`・既定）＝**ページを足すだけ**。backlog に置かれ、後で schedule（時刻）や recall（連想）が surface し、`activate` で掴む。

普通のタスク積み（後者）が日常運用の本体。前者は「すぐ取りかかる」ショートカット。

### memo との境界（2026-06-19）

**多段で取り組む「目標そのもの」は plan の領分／単発の事実・在庫・リスト・素材の記録は memo。** 実機で「過去の話題が plan に乗らず memo に流れて漂流」（既存 plan を認識せず memo が `goals/*.md` に技術メモを書く）を観測したため、両 criteria に境界を明記し、**memo は `goals/`（plan 所有の派生ビュー）に書かない**（書くと次の renderPlan で上書き消失・取り合いになる）＝memo の locate からも `goals/` を除外し、書き込み先が `goals/` なら no-op で plan に譲る。

### いつ動く（criteria）

- 相手が「目標を立てたい / 始めたい / やめたい / 変えたい」と言ったとき。
- **エバ自身が独り言で**「あれ再開しよう」「明日のために予定足しとこ」と思ったとき（**自己起点を開ける**＝従来の相手寄り criteria を緩める）。
- idle で backlog / schedule から plan が surface し、掴む価値があるとき。
- ❌ 日々の milestone ✓だけ＝進行係（processor）の仕事なので起動しない。

---

## surface（思い出す）— **idle 限定**（2026-06-19 確定）

plan を「常時の背景 recall」に混ぜると**引っ張られすぎる**＝過剰発火でタスク固執（タコ耳）が復活する。理由: plan は命令形（「やれ」）で行動への引力が episode より強い／ゴールは広くマッチする／recall は毎ターン。会話中も todo に気を取られる人になる。人間は会話中ずっと todo に引っ張られない＝**強くゲートされている**。

なので **plan の surface は普通の recall とは別扱いにし、idle（静穏）でだけ起こす**：

- **常時 recall には plan を混ぜない**（過剰引力の元を断つ）。topical な連想 plan recall（`plans_index` を背景 recall に載せる案）は欲しくなってから高閾値で慎重に、として**当面やらない**。
- **idle（静穏 heartbeat）でだけ surface**＝会話中は引っ張られない。「手が空いた→何しよう」。
- **drive ゲート／間引き**＝idle のたび全部でなく、時々・強いものだけ（毎 idle で必ず拾うと作業マシン化＝非人間的）。

### v1 の2本（どちらも idle で・過剰に引っ張らない）

1. **idle backlog surface**（本体）: idle のとき backlog（未完 plan・recency 順）を文脈に出し、**「手」（plan actor）が activate するか判断**する＝選択は中央スケジューラでなく観測駆動（哲学）。charge 用の plan importance フィールドは持たず、提示順（recency）＋ LLM 判断で v1。＝普通にタスクを積む/思い出して掴む、が固い本体。
2. **schedule（時刻・暫定）**: plan に任意の時刻アンカー（一回きり `at` / 繰り返し `recur`）。idle の「期限チェック」で時計と照合し来ていれば surface（一回きりは消費・繰り返しは1周期1回）。時刻＝客観条件＝機械ゲート許容枠内。
   - **割り切り（確定）**: チェックは idle のみ＝**会話中はスケジュールが発火しない**。会話を終えて手が空いた次の idle で気づく＝むしろ人間的。最初はこれで可。
   - ⚠️ schedule はこの設計のまま完璧には動かない可能性あり（「やってみてから直す」前提）。

## ドライブ／自発性との関係（Tier 2）

「手」＋「surface（idle backlog/schedule）」が揃うと、idle で plan が浮かぶ→`activate` で掴む、という**自発の点火**ができる。これが embodied-claude（ここね）比で不足していた「自発的に動く」の土台。中央スケジューラ（ジャッジ復活＝哲学違反）は作らず、**surface は idle 限定・選択は plan actor の判断**で回す。DECISIONS §集中モード「計画実行の3層構造」Tier 2。

## 実装状況

- 進行係（plan processor）: 実装済み。
- 手（plan actor）: **実装済み（2026-06-19）**。`listPlans()`（backlog 一覧）／op に `planId` target＋`activate`/`shelve`/`retire`＋`new_goal` の `activate` フラグ／自己起点の criteria。facts.action（create/activate/shelve/retire/update）で orchestrator が focusPlan を制御（activate→開始・shelve/retire→手放す）。entry は「計画を触った＝集中」でなく**明示 activate**に変更。ユニットテスト＋実機1ターン（backlog の既存 plan を activate→focusPlan 起立）で確認。
- 目覚まし（schedule/cron）: 暫定設計・未実装。
- recall に plan を入れる（plans_index）: 未着手（手ができたので次に判断可）。
