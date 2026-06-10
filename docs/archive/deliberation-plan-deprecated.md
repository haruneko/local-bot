# ~~実装プラン: 連続ターン実行 ＋ メタ自己状態による双方向ループ~~

> **⚠️ DEPRECATED**: このアプローチは設計議論の結果、不採用となった。  
> 「深い思索・深い想起」の問題はサブエージェントの内部ループ（`done=false` の多段ステップ）で
> すでに原理的に解決可能であることが判明した。cross-turn の連続実行ループ・selfStatus・
> updateSelfStatus はいずれも不要と結論。  
> **記録として残すが、実装しないこと。**

---

## 1. Context（なぜ・何を）

現アーキテクチャは「入力 → 1決断 → 1行動 → 出力」の単パスで、双方向の熟考（想起が次の想起を生む自己参照ループ）を持てない。

**初期案の誤りと訂正:** 当初「Judge が"思索が必要"と判断して深掘りモードに入る」案だったが、これは「recall が不十分かを実行前に知れない」（DECISIONS の `deep_recall` 却下理由 E')と同じ**予測ゲートの罠**。実行前予測は違法（意識はリーズニングにアクセスできない）。

**採用する方針:** ループを**既定**にし、"止める"判断だけを残す。止める判断は**結果を見た事後判断**なので合法。

- 全ターン（user_message も heartbeat も）は、**未完了がある限り・予算がある限り、連続でターンを回す**。
- 止まる条件は2つだけ: **(a) 未完了（open item）がなくなった** か **(b) 連続ターン予算を使い果たした**。
- 「未完了があるか」は、**自己状態（メタ自己認知）を観測して**判定する。予測ではなく、自分の結果状態を読むだけ。

### 確定した設計判断
1. **思索という別 State は作らない**。`AgentState` は `対話`/`静穏` のまま。全ターンが既定でループ対象（**統合**）。
2. メタ自己状態は **フリーテキストの「自己状況」**（`innerState` と同様に毎ターン書き換える短い自己記述）。open item・現在の関心・進捗を自然言語で保持する。構造化リストにはしない。
3. 予算を使い果たしても未完了が残るときは、**自己状況に残して後続ターン/heartbeat で再開**（同期バーストと非同期タスクキュー §12 G が自然に統一される）。
4. 連続ターン予算（残り何周）は**内部センサー**として全ロールに配る。
5. 思考深度は `workingMemoryTurns` に結びつく（独り言が窓を超えると古い順に押し出され自然収束）。**ゴール（元の問い）は自己状況に載るので窓からスクロールアウトしても消えない**。

### 絶対に守る原理（#1・最重要 / 違反するとコンセプトが壊れる）
- 自己状況は **「計画台帳」ではなく「結果の外部化物」**。作業記憶・内省と同じ「過去の結果として観測できる事実」。
- 「未完了か」を出すのは、行動・発話の**後**に結果を振り返る反省ステップ（後述 `updateSelfStatus`）。**実行前の予測をする箇所を作らない**。
- Judge は自己状況を**文脈の事実として読んで反応してよい**（作業記憶を読むのと同じ）が、自己状況を「推論の台帳」として扱ってはならない。

---

## 2. 自己状態の三分（混ぜないこと）

| 名前 | 保持先 | 中身 | 書き換える人 |
|------|--------|------|--------------|
| `AgentState` | state.json `state` | 行動モード（対話/静穏） | Judge の NEXT_STATE |
| `innerState` | state.json `innerState` | 感情の余韻（既存） | `updateInnerState`（既存） |
| **`selfStatus`（新規）** | state.json `selfStatus` ＋ `selfStatusOpen` | 現在の関心・未完了・進捗（フリーテキスト）＋ 未完了フラグ | **`updateSelfStatus`（新規）** |

> 現 state.json の `innerState` は「次は〜しよう」へ滲んでいる（カテゴリ違反）。今後 `innerState` は感情のみ、未完了・関心は `selfStatus` に分離する。

---

## 3. 実装ステップ（順序どおり・各ステップ後に `npm test` / `npm run build`）

### Step 1 — 永続化に selfStatus を追加
**`src/state/persist.ts`**
- `PersistedSession` に `selfStatus: string` と `selfStatusOpen: boolean` を追加。
- `loadSession` の戻り値（`Pick<...>`）に両フィールドを追加。`selfStatus` は文字列でなければ `""`、`selfStatusOpen` は真偽でなければ `false`。
- `saveSession` の引数・payload に両フィールドを追加（未指定時は `""` / `false`）。
- `bootstrap.ts` の fallback セッション（`statePath===false` 時）にも `selfStatus:""`, `selfStatusOpen:false`。

### Step 2 — オーケストレータに自己状態フィールドを持たせる
**`src/orchestrator/turn.ts`**
- `TurnOrchestrator` に `private selfStatus: string` と `private selfStatusOpen: boolean` を追加（`innerState` と同じ初期化経路）。`TurnDeps` に `initialSelfStatus?` `initialSelfStatusOpen?` を追加し、`bootstrap.ts` の `session` から渡す。
- `persistSession()` と `onSessionPersist` 呼び出しに `selfStatus` / `selfStatusOpen` を追加して保存する。

### Step 3 — 新ロール `updateSelfStatus`（反省ステップの拡張）
**`src/roles/self-status.ts`（新規）**

契約:
```ts
updateSelfStatus(llm, {
  prevSelfStatus: string,
  introspection: string,
  speech: string | null,
  action: ActionOutcome,
  currentDateTime: string,
}): Promise<{ status: string; open: boolean }>
```

**⚠️ プロンプト設計は §8「得られた知見」を必読。「行動失敗のみ open=true」が正しい設計。**

parse 失敗時は `{status: prevSelfStatus, open:false}` にフォールバック（止まる側に倒す）。

### Step 4 — ターン末尾で selfStatus を更新
**`src/orchestrator/turn.ts` `run()`**
- `updateInnerState` の直後に `updateSelfStatus` を呼び、`this.selfStatus` / `this.selfStatusOpen` を更新。
- `persistEpisode` が false（idle heartbeat・何も起きていない）の場合は **`this.selfStatusOpen = false`**。
- `TurnResult` に `selfStatusOpen: boolean` を追加。

### Step 5 — 連続実行ループ `runUntilSettled`
**`src/orchestrator/turn.ts`**
```ts
async runUntilSettled(trigger: TurnTrigger): Promise<TurnResult[]> {
  const max = this.deps.maxConsecutiveTurns ?? 5;
  const results: TurnResult[] = [];
  let r = await this.run(trigger);
  results.push(r);
  let iteration = 1;
  while (r.selfStatusOpen && iteration < max) {
    this.deliberationBudget = { iteration, max };
    r = await this.run({ type: "heartbeat" });
    results.push(r);
    iteration++;
  }
  this.deliberationBudget = undefined;
  return results;
}
```

### Step 6 — 予算センサーを全ロールへ
**`src/context/turn-context.ts`**
- `TurnContext` に `deliberation?: { iteration: number; max: number }` と `selfStatus: string` を追加。
- `memorySnapshot(ctx)` に両フィールドを含める。
- `buildJudgeContextSuffix` / `renderLanguageUserContent` / `renderIntrospectionPrompt` に deliberationLine と appendSelfStatus を追加。
- 表示例: `（連続思考: 3周目 / 上限5）`

### Step 7 — 設定
- `config/settings.json` に `"maxConsecutiveTurns": 5` を追加。
- `src/config/settings.ts` に `resolveMaxConsecutiveTurns()` を追加。

### Step 8 — プロンプト修正（§8「得られた知見」に従うこと）
**`src/prompts/roles.ts`**

JUDGE_SYSTEM への追加:
- `context.selfStatus` の読み方（事実として反応する。台帳推論しない）
- 連続思考センサーが残り少なければまとめる方向で REPLY true

LANGUAGE_HEARTBEAT_SYSTEM_PREFIX の独り言テンプレート修正:
- 行動結果があるとき: 結果だけ述べる。「次は〜しよう」は書かない
- 行動も依頼もないとき: 短い観察

INTROSPECTION_SYSTEM への追加:
- 「次は〜すべき」「〜する必要がある」という未来の計画は書かない

SELF_STATUS_SYSTEM（**§8 参照。初回実装で失敗した箇所**）

### Step 9 — CLI 入口の差し替え
- `src/cli/main.ts` / `src/cli/heartbeat.ts` / `src/cli/slack.ts` を `runUntilSettled` へ
- `src/cli/output.ts` に `printBurstSummary(results[])` を追加

wrinkle: heartbeat かつ REPLY=true のとき → dialogue チャンネルで append（monologue にしない）

### Step 10 — ドキュメント更新
- `docs/DECISIONS.md` / `docs/CONCEPT.md` / `docs/SPEC.md` を更新

---

## 4. 既存資産の再利用

| 機能 | 場所 | 役割 |
|------|------|------|
| 独り言→作業記憶 | `turn.ts` | ループ媒質 |
| heartbeat+ACTION成功で言語野起動 | `shouldRunLanguage` | 思考中の独り言生成 |
| 作業記憶→コンテキスト | `createTurnContext` | 前周の独り言を次ターンへ |
| 内心持ち越し | `updateInnerState` | 感情の継続（selfStatus と分離） |
| 直近想起除外 | `excludeTurnIds` + `recencyExclusionTurns` | 自分の独り言で想起を汚さない |

---

## 5. テスト

- `runUntilSettled`: open=true の間ループし、open=false で停止する。
- `runUntilSettled`: `maxConsecutiveTurns` で停止し、open=true のまま残る（次回再開可能）。
- 雑談（open=false 即時）は1周で停止。
- heartbeat idle → `selfStatusOpen = false`。
- heartbeat REPLY=true → dialogue チャンネルで append（monologue にしない）。
- persist: `saveSession`/`loadSession` が `selfStatus`/`selfStatusOpen` を往復する。
- 既存の idle heartbeat スキップ挙動を壊さない。

---

## 6. 手動確認

- 雑談（「こんにちは」）→ 1周で停止。
- 行動失敗するシナリオ（例: MCP 接続失敗）→ open=true で heartbeat リトライ。
- `maxConsecutiveTurns` を小さくし、予算切れで未完了が自己状況に残り、次の `/heartbeat` で再開することを確認。

---

## 7. 実装者への注意

- **予測する箇所を新設しない**。継続/停止は反省ステップ（結果の事後観測）の `open` フラグだけで決める。
- 自己状況・内心・State の三役割を混ぜない。
- 自己状況は「結果の外部化物」。Judge は読むが台帳推論しない。

---

## 8. 得られた知見（再実装前に必読）

### 8.1 問題の再現

実装後に以下のシナリオで暴走が観測された:

1. ユーザーが「調整したけどどうかな？」と言う
2. ボットが「詳しく教えてください」と返す（ACTION なし）
3. selfStatus が `open=true`、status = "HALによる調整の具体的な内容と結果を確認するため..."
4. heartbeat ループが発火して Judge が `research: "HALが行った調整を確認する"` を決定
5. web_search "HAL 調整 結果 確認" → 無関係な PDF 群がヒット
6. 意味不明な独り言を生成して繰り返す

### 8.2 根本原因

`SELF_STATUS_SYSTEM` に以下の条件を入れたことが誤り:
```
open=true: ユーザーの明確な依頼・質問があり、まだ答えられていない
```

この条件が「会話的な問いかけ」にも適用されてしまう。
- 「調整どうかな？」は会話的な問いかけ。ボットが「教えて」と聞き返したら **返答待ち** = ACTION 不要。
- しかし selfStatus は「まだ答えられていない」→ `open=true` と判定。
- Judge が selfStatus の「確認するため」という文言を読んで `research` ACTION を選んでしまう。

さらに、`open=true` のとき status に「何のために次のターンで行動が必要か」を書かせるプロンプトが、暗黙的に「ACTION の intent」を書かせていた。Judge はそれをそのまま research の intent として使ってしまう。

### 8.3 正しい設計: selfStatus は「行動失敗の追跡」だけ

`open=true` にできる唯一の根拠は **「このターンで ACTION を試みたが失敗した」** のみ。

```
open=true:  【行動】ブロックがあり「できなかった」→ 再試行が必要
open=false: それ以外すべて
  - ACTION していない（会話のみ、聞き返し含む）
  - ACTION して「できた」
```

**なぜこれで十分か:**
- Judge はユーザーメッセージを読んでその場で research/memory を決める（同ターン内完結）
- selfStatus は「同ターン内では完了できなかった ACTION の跨ぎ追跡」に特化すればよい
- 「ユーザーに聞き返した = 返答待ち」は ACTION を必要としない → open=false が正しい

### 8.4 修正すべき SELF_STATUS_SYSTEM

```
このターンで行動（ACTION）に失敗したかだけを判定してください。

open=true: 【行動】ブロックがあり「できなかった」→ 次のターンで再試行が必要
open=false: それ以外すべて
  - ACTION していない（会話のみ・聞き返し・相槌など）
  - ACTION して「できた」
  - 「次は〜したい」という意欲だけがある（行動していない）

open=true のとき: status に「何の ACTION が失敗したか」を1文で書く（"〜を確認するため"という目的文を書かない）
open=false のとき: status は空文字
ジャッジ・AI・内部仕組みには触れない
JSON 1つだけを返す: {"status":"...","open":true/false}
```

### 8.5 Judge プロンプトへの追記も必要

selfStatus の読み方に「ユーザー依頼が未回答」の言及を残さないこと。以下のように書く:

```
- context.selfStatus は「前ターンの ACTION 失敗の記録」。
  ACTION を試みて「できなかった」場合のみ open=true になる。
  open=true なら同じ ACTION を別の手段で再試行してよい。
  「会話的な問いかけへの返答待ち」は open=false であり、heartbeat で web 検索する理由にならない。
```

### 8.6 その他の修正点（実装済みで問題なかったもの）

以下は今回の実装で問題なかった。再実装時もそのまま踏襲する:

- `runUntilSettled` ループロジック自体は正しく動作した
- 予算センサー（deliberation）の全ロール配布は正しく動作した
- heartbeat REPLY=true → dialogue チャンネル分岐は正しく動作した
- idle heartbeat で `selfStatusOpen = false` にする処理は正しかった
- persist/load は正しく動作した
- テストコードのロジック（`SELF_STATUS_CLOSED` fake レスポンス追加）は正しかった
