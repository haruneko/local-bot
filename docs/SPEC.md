# 振る舞い仕様書（SDD）

CONCEPT.md v0.4 と [DECISIONS.md](./DECISIONS.md) に基づく実装契約。テストは本書の MUST 節を根拠に書く。

## 1. 用語

| 用語 | 意味 |
|------|------|
| ターン | トリガー 1 回につき 1 回完結する処理単位 |
| コンテキスト | 揮発。プリプロセス出力。ターン終了で破棄 |
| 作業記憶 | ユーザーとボットの**表面発話**のみ。各エージェントの判断・ツール結果は含めない |
| 内心ステート | 持ち越す生の感情（余韻）。`data/state.json` に永続化。空 = 起きたて |
| ToolLog | ターン内のみ保持。言語野くん向け。内省くんには渡さない |

## 2. State

- 既知ラベル: `対話` | `静穏`
- `NEXT_STATE` は検証せず代入する
- 未知値: `console` ログに `unknown_state` として記録し、その値のまま保持

## 3. 設定（`config/settings.json`）

```json
{
  "workingMemoryTurns": 20,
  "contextTokenBudget": 6000,
  "episodeRecallTopK": 3,
  "recencyExclusionTurns": 4,
  "chatModel": "gemma4:31b",
  "embedModel": "nomic-embed-text:latest",
  "ollamaHost": "http://192.168.16.1:11434",
  "stateConfig": {
    "対話": { "workingMemoryTurns": 20, "episodeRecallTopK": 3 },
    "静穏": { "workingMemoryTurns": 5,  "episodeRecallTopK": 1 }
  },
  "roles": {
    "memory":        { "model": "gemma4:31b", "think": false },
    "research":      { "model": "gemma4:31b", "think": true  },
    "language":      { "model": "gemma4:31b", "think": false },
    "introspection": { "model": "gemma4:31b", "think": false },
    "innerState":    { "model": "gemma4:31b", "think": false }
  }
}
```

環境変数 `OLLAMA_HOST` があれば `ollamaHost` より優先。

## 4. ターン処理（オーケストレータ）

### 4.1 トリガー

| 種別 | 入力 | 備考 |
|------|------|------|
| `user_message` | 発話文字列 + `speakerId` | State は変更しない（現 State のまま） |
| `heartbeat` | なし | `/heartbeat` 相当 |

### 4.2 フェーズ順（固定）

1. **プリプロセス** → `TurnContext` 生成（`stateConfig` でフィルタ量決定。元データ変更なし）
2. **memory-agent** → 記憶操作を自己判断・実行 → `ctx.actions` に追加
3. **research-agent** → 外部情報取得を自己判断・実行 → `ctx.actions` に追加
4. **language-agent** → 全 facts を受け取り発話生成 + NEXT_STATE 出力 → `ctx.speech` / `ctx.nextState` を設定
5. **内省くん**（`shouldPersistIntrospection(ctx)`）→ `introspection: string` → エピソード追記
6. **内心更新**（内省と同条件）→ `updateInnerState` で `innerState` を書き換え → `data/state.json` に永続化
7. **State 更新** `state = ctx.nextState`
8. **`TurnContext` 破棄**

idle heartbeat 判定:
- トリガーが `heartbeat` かつ `ctx.actions` が空 かつ `ctx.speech` が空 → 内省・内心更新をスキップ
- `shouldRunLanguage` は廃止。language-agent は常に起動し発話するかを内部で判断する

### 4.3 作業記憶の更新

- `ctx.speech` が非空: ボット発話を append
- `user_message` トリガー: ユーザー発話を append
- `ctx.speech` が空: ボット行は追加しない
- プロンプト漏洩などで作業記憶が汚染されたときは `data/state.json` の `workingMemory` を `[]` に戻してリセットする

## 5. memory-agent

### 5.1 起動条件

毎ターン必ず起動。活性化するかは LLM が 1 コールで決める。

### 5.2 LLM 出力スキーマ（Zod）

```typescript
{ activate: false }
| { activate: true; tool: MemoryTool; intent: string }
```

- MUST: Ollama chat + `format` = 上記 JSON Schema
- パース失敗・リトライ失敗 → `{ activate: false }` にフォールバック

### 5.3 ツール

| tool | 機械処理 |
|------|----------|
| `remember` | LanceDB append |
| `recall` | LanceDB vector search |
| `forget` | LanceDB ソフト削除（`deleted` フラグ） |
| `memo_write` | `data/notes/` write |
| `memo_read` | list / read（冒頭抜粋インデックスで pick） |
| `distill` | スタブ（未実装） |

`activate: true` のとき即実行し `ctx.actions` に `ActionOutcome` を追加。

## 6. research-agent

### 6.1 起動条件

毎ターン必ず起動。memory-agent の facts を含む TurnContext を読んで活性化を判断。

### 6.2 LLM 出力スキーマ（Zod）

```typescript
{ activate: false }
| { activate: true; tool: string; intent: string }
```

動作は memory-agent と同様。MCP 未接続時は `FakeMcpToolProvider` のスタブツール。

### 6.3 ActionOutcome（共通型）

```typescript
type ActionFacts =
  | { kind: "memo_read"; filename: string; body: string }
  | { kind: "memo_write"; filename: string; body: string }
  | { kind: "remember"; body: string }
  | { kind: "recall"; bullets: string[] }
  | { kind: "forget"; body: string }
  | { kind: "research"; tool: string; title: string; body: string }
  | { kind: "express"; tool: string; title: string; body: string };

type ActionOutcome = { attempted: false } | {
  attempted: true;
  kind: ActionKind;
  intent: string;
  status: "succeeded" | "failed";
  facts?: ActionFacts;
  summary: string;
  error?: { code: string; message: string; detail?: string };
};
```

`ctx.actions: ActionOutcome[]` に memory-agent → research-agent の順で追加。`summary` の regex 再パースは行わない。

## 7. language-agent（言語野）

### 7.1 起動条件

毎ターン必ず起動。`shouldRunLanguage` は廃止。発話するかどうかは LLM が内部で決める。

### 7.2 入力

- `renderLanguageUserContent(ctx)` — `memorySnapshot(ctx)` と同じ事実フィールドを参照
- **`## いまの内心`** — `innerState` が非空のときのみ。温度の素として味わい、同じ内容を言い直さない（台本にしない）
- **今ターンの行動結果** — `formatActionsForLanguage(ctx.actions)` が各 `facts` から事実文を組み立て（一人称は載せない。口調は character.md）
- `ctx.persona`（`persona/character.md`）

### 7.3 LLM 出力スキーマ（Zod）

```typescript
{ speech: string; nextState: string }
```

`speech` が空文字のとき発話なし（`ctx.reply = false`）。`nextState` バリデーションなし。

### 7.4 出力

- `ctx.speech` に格納し CLI に表示（非ストリーム MVP）
- `ctx.nextState` に State 遷移先を格納

## 8. 内省くん

### 8.1 入力組み立て（`renderIntrospectionPrompt(ctx)`）

固定テンプレート。各エージェントの判断プロセスは参照しない（`ctx.speech` と `ctx.actions` のみ使用）。

**状況行**

- `（状況: {state} / {currentDateTime}）` — ターン開始時の State と日本語日時

**会話ブロック**

- `formatWorkingMemoryChannel(ctx)` — 直近の会話（相手の今ターン発話を含む）

**発話ブロック**

- `【いま自分が言ったこと】` — `ctx.speech` あり: 生成した `speech`
- `ctx.reply === false` かつ speech なし: `（返答はしなかった）`

**行動ブロック**（`ctx.actions` に attempted なものがあるとき。複数エージェントの結果を順に掲載）

```
【行動】
やろうとしたこと: {kind の日本語ラベル} — {intent}
結果: {できた | できなかった}
内容:
{formatActionForIntrospection — facts または失敗 summary}
```

`status === succeeded` → `できた`、`failed` → `できなかった`。

### 8.2 出力

- 一人称の内省本文（プレーンテキスト）
- LanceDB レコードの `body` フィールド

### 8.3 メタデータ（エピソード）

```typescript
{
  timestamp: string;      // ISO8601
  participants: string[];
  tags: string[];         // MVP: []
  state: string;          // ターン開始時の State
  action: string | null;
  reply: boolean;
  turnId: string;
}
```

## 9. プリプロセス

- センサー: システム時刻（ISO8601）を常に含める
- 作業記憶: 直近 `workingMemoryTurns` 件
- エピソード想起: 直近ユーザー発話（なければ空文字）で embed → top-k → **直近 `recencyExclusionTurns` ターンの turnId を除外**（`excludeTurnIds`）→ 距離分類 → `summarize`/`vague` は LLM が作業状況に照らして提示文を生成（無関係なら省略）
- トークン超過時: 8B でチャンネル要約（失敗時のみ機械切り詰め）

## 10. CLI

```
npm run dev
> こんにちは
< ボットの返答

/heartbeat
/state 静穏
/quit
```

起動: `npm start -- --user user_001`

## 11. テスト要件（TDD）

| ID | 内容 |
|----|------|
| T-M01 | memory-agent: 有効な `{activate, tool, intent}` JSON をパースできる |
| T-M02 | memory-agent: パース失敗後のフォールバック（`activate: false`） |
| T-R01 | research-agent: 有効な `{activate, tool, intent}` JSON をパースできる |
| T-R02 | research-agent: パース失敗後のフォールバック（`activate: false`） |
| T-L01 | language-agent: `speech` 空 → 発話なし（`ctx.speech` 空文字） |
| T-I01 | 内省: `ctx.speech` 空 → 発話固定文 |
| T-I02 | 内省: `ctx.actions` 空 → 行動ブロックなし |
| T-I03 | 内省: action 成功 → 「できた」 |
| T-I04 | 内省: action 失敗 → 「できなかった」 |
| T-T01 | ターン終了後に TurnContext が破棄される（`getTurnContext()` が null） |
| T-W01 | 作業記憶に各エージェントの判断出力が入らない |

## 12. 将来（本 SPEC の範囲外）

- 言語野ストリーミング
- 行動くんの分岐（SNS / ファイル / 予定）
- State 別エピソードフィルタ
- 意味記憶・外部センサー
- 本格 MCP サーバプロセス接続
