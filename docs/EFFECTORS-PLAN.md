# 作用器（effector）の導入計画 — 知覚の双対としての「作用」

状態: 計画（2026-06-18 起案）。doc-first で設計を固めてから段階実装する。
発端: async-reflect（発話を先に返す）の検討で、「発話の出力だけ orchestrator が特別扱いして外から出す」
非対称が露見した。memo はファイルを・webcam はカメラを「自分の run で」叩くのに、発話だけ pull で外。

## 0. 語彙（確定）

- **効果器（effector）**＝世界へ作用する出力器官。口＝発話、手＝記録(notes)、首＝カメラ運動、外界探索＝MCP。
  生物学の教科書ペア **受容器(receptor)⟷効果器(effector)** の効果器。`-or`＝する側（doer）。
  ※ `effectee`（される側＝世界・対象）は不採用（主客が逆）。`actuator` でなく、知覚＝sensor の双対として
  生物メタファの effector を採る（「人間に倣う」思想）。
- **完遂前提**: 分割実装はするが**半移行で放置しない**。下の「完遂の定義」に到達して初めて完了。

## 1. 原則（コンセプトの芯）

**知覚（sensor / 知覚チャンネル）に双対な「作用（effector / 作用器）」を立てる。**
actor／faculty は、世界への effect（作用）を **自分が持つ effector で自分で起こす**。orchestrator が
特定の effect を外から代行しない。

| 入力＝知覚 | 出力＝作用 |
|---|---|
| 時刻・会話・image_feed・audio_feed（センサー→チャンネル） | 発話（口）・記録（手）・カメラ運動（首）・検索（外界探索） |
| `preprocess` がチャンネルに載せる | 各 action が **effector** で起こす |

- **発話＝「口」＝効果器の1つ**。記録（notes）＝手、カメラ運動＝首、と同列。特別経路を持たない。
- これは embodied-claude／ARCH-NEXT「全部 actor・とっさの返事」の土台＝**input=sensors / output=effectors** の対称を完成させる。

## 2. なぜ（決定の根拠）

1. **一貫性**: 副作用は「それを持つ行為」が起こす、で全 action が揃う（発話だけ特別扱いしない）。
2. **コンセプト整合**: 身体性＝センサー（目/耳）と効果器（口/手/首）の対。発話を効果器化すると embodiment の絵が一枚で閉じる。
3. **async-reflect が副産物として落ちる**: 発話ステップが自分で喋る → 内省/affect は喋った後に走る、が
   特別扱いなしの自然な帰結。体感 ~6s（反省 ~5.9s は裏）。研究: research/merge-lang-intro-refutation-2026-06-18.md。
4. **拡張性**: TTS（口）・サーボ（首）・別媒体（Slack/REPL/LINE）が同じ effector 抽象に乗る。

## 3. 設計（contract のスケッチ・実装時に詰める）

- **`OutputChannel`（口の effector）**: `say(speech, artifacts)`（媒体別の出し分けは実装内）。
  まずこの1つを deps に注入（`deps.actionDeps.mcp` を渡すのと同じ立て付け）。
- **発話ステップが say する**: 言語野が speech 生成直後に `outputChannel.say(...)`。
  `TurnResult.speech` は当面ログ/互換のため残す（push と pull の併存→移行）。
- **アダプタ（slack.ts / say.ts）の役割転換**: 「TurnResult を消費して出力」→「**OutputChannel を提供**」。
  mcp を提供しているのと同じ構造。
- **順序（不変条件）**: actor（記録/検索/カメラ等の effect）は発話の上流＝発話 say 時点で副作用も成果物も確定済み。
  内省/affect は say の後（ctx.actions を読むので記憶は正確）。**次ターンの recall は今ターンの affect/episode に
  依存＝反省は次ターン前に完了**（run() が反省まで await して返す＝整合は不変）。
- **スコープ外（別物・踏み込まない）**: 「遅い action を待たず発話を先に出し結果は後から届ける」＝**async action**
  （ROADMAP §非同期複雑タスク・タスクキュー要）。今回は action は同期（発話の上流で完了）のまま。

## 4. フェーズ（doc-first → 段階実装）

- **A. 設計確定（doc）**: 本計画 → CONCEPT（効果器の原則）→ ARCH-NEXT（全部 actor への一歩として位置づけ）
  → DECISIONS（決定記録）→ SPEC（contract: OutputChannel・発話 say・順序・互換）。
- **B. 実装（分割するが完遂する）**:
  - B1（✅ 完了・commit d4c1a9a）: 口の効果器。`OutputChannel`(`say`) を deps 注入／言語野が発話直後に say／
    slack を effector 提供側へ（可変 sink・二重投稿撤去）／async-reflect 成立（say は反省より前）。
    say.ts は当面 pull のまま（単発 CLI・併存）。tests T-OC01/02。
  - B2（✅ 完了）: say.ts も効果器（OutputChannel）に揃え、両アダプタが提供側に。残る effect（手=notes/plan・
    外界探索=MCP）は元々 **actor 所有**で特別経路なし＝効果器経由を確認（手=writeNoteContent/savePlan、探索=deps.mcp）。
    首=webcam は未実装。
  - B3（✅ 完了）: `printTurnSummary` から発話/成果物の出力を撤去＝`TurnResult.speech` は**出力路でなくログ/戻り値専用**に。
    ユーザー出力は効果器（OutputChannel）が唯一の経路。
- **残（任意・非ブロッキング）**: 手/plan の効果器を module-fn(writeNoteContent/savePlan) から**注入式**へ揃える uniformity 改善。
  特別経路ではない（actor 所有）ので完遂はブロックしない。発話の完全 actor 化は D。
- **C. テスト/検証**: say が反省の前に呼ばれる・反省は後・クロスターン整合・体感レイテンシ実測。各 effector に最小テスト。
- **D. 先（ARCH-NEXT 本体）**: 発話を完全に actor 化（pool 入り）・TTS/サーボを効果器として追加・板/フレーム。

## 4.5 完遂の定義（Definition of Done）

本計画は次に**全部**到達して初めて完了（半移行で止めない）:
- [x] 全ての副作用（発話・notes 記録・plan・MCP）が**効果器経由**で起こる（口=OutputChannel／手=writeNoteContent・savePlan／探索=deps.mcp。首=カメラは未実装）。
- [x] orchestrator が特定 effect を外から代行する**特別経路がゼロ**（発話の pull を出力路から撤去）。
- [x] `TurnResult.speech` は "ログ/戻り値専用" に明記＝push（OutputChannel）が唯一の出力路。
- [x] CONCEPT/SPEC/DECISIONS/ARCH-NEXT が効果器モデルで整合。
- [x] 各効果器に最小テスト（口=T-OC01/02・手/探索=既存 actor テスト）＋体感レイテンシ実測（発話3.9s/反省込み9.1s）。
- **完了（2026-06-18）**。残る任意改善＝手/plan の効果器を注入式へ（非ブロッキング）・発話の完全 actor 化（D）。

## 5. 影響ファイル（B1 の見込み）
`src/orchestrator/turn.ts`（発話後 say・deps）／`src/roles/language*.ts`（または turn 側で say）／
`src/app/bootstrap.ts`（OutputChannel 配線）／`src/cli/slack.ts`・`src/cli/say.ts`（effector 提供）／
型（TurnDeps）／tests。`TurnResult.speech` は互換で残す。

## 6. 非目標（ただし完遂は別）
- **一括**の effector 化＝避ける（事故るので分割）。但し**漸進で完遂する**（B2/B3＝必須・§4.5 Done）。「後で任意」ではない。
- 発話の完全 actor 化（D・先）。
- async action（遅い行動を待たず結果を後から届ける＝ROADMAP §非同期複雑タスク・別腰）。
