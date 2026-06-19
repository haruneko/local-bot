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

### いつ動く（criteria）

- 相手が「目標を立てたい / 始めたい / やめたい / 変えたい」と言ったとき。
- **エバ自身が独り言で**「あれ再開しよう」「明日のために予定足しとこ」と思ったとき（**自己起点を開ける**＝従来の相手寄り criteria を緩める）。
- recall / schedule で plan が surface し、掴む価値があるとき。
- ❌ 日々の milestone ✓だけ＝進行係（processor）の仕事なので起動しない。

---

## schedule / cron（目覚まし・暫定）

定期・予定時刻で plan を出す機構。連想（fuzzy）に「朝」等を混ぜると recall クエリが濁るため、**時刻は別口の機械トリガー**にする（時刻＝客観条件＝既存の機械ゲート許容枠内。recall=常時・視覚=画像有無・urlBrowse=URL正規表現 と同じクラス）。

- **登録**: plan に任意の時刻アンカー（一回きり `at` / 繰り返し `recur`）。`new_goal` の延長で積める。
- **発火**: preprocess の小さな「期限チェック」で時計と照合し、来ていれば surface。一回きりは fire 後に消費、繰り返しは1周期1回（消費は機械）。
- **着地**: surface した plan は「手」の `activate`（多段なら集中へ）か、単発なら1ターンで実行して完結（集中に入れない経路）。

> ⚠️ **この cron 部分はこの設計のままだとうまくいかない可能性が高い（要検証）。** まず「手」で**普通にタスクを積む/掴む/しまう**を固め、cron は動かしてから直す前提の暫定。

---

## recall に plan を入れるか（未決・要相談）

作りかけ project が idle で自然に再浮上するには plans を背景 recall（連想）に載せたい（`plans_index` を vector で）。一方、載せると recall に別種が混ざる懸念もある。**「手」を作った後で判断**（手が前提）。載せない場合は「project の再浮上をどう起こすか」を別途要設計。

## ドライブ／自発性との関係（Tier 2）

「手」＋「surface（recall/schedule）」が揃うと、idle で plan が浮かぶ→`activate` で掴む、という**自発の点火**ができる。これが embodied-claude（ここね）比で不足していた「自発的に動く」の土台。中央スケジューラ（ジャッジ復活＝哲学違反）は作らず、**surface は連想/時計・選択は plan actor の判断**で回す。DECISIONS §集中モード「計画実行の3層構造」Tier 2。

## 実装状況

- 進行係（plan processor）: 実装済み。
- 手（plan actor）: **実装済み（2026-06-19）**。`listPlans()`（backlog 一覧）／op に `planId` target＋`activate`/`shelve`/`retire`＋`new_goal` の `activate` フラグ／自己起点の criteria。facts.action（create/activate/shelve/retire/update）で orchestrator が focusPlan を制御（activate→開始・shelve/retire→手放す）。entry は「計画を触った＝集中」でなく**明示 activate**に変更。ユニットテスト＋実機1ターン（backlog の既存 plan を activate→focusPlan 起立）で確認。
- 目覚まし（schedule/cron）: 暫定設計・未実装。
- recall に plan を入れる（plans_index）: 未着手（手ができたので次に判断可）。
