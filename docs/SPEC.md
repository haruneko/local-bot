# 振る舞い仕様書（SDD）

CONCEPT.md v0.4 と [DECISIONS.md](./DECISIONS.md) に基づく実装契約。テストは本書の MUST 節を根拠に書く。

## 1. 用語

| 用語 | 意味 |
|------|------|
| ターン | トリガー 1 回につき 1 回完結する処理単位 |
| コンテキスト | 揮発。プリプロセス出力。ターン終了で破棄 |
| 作業記憶 | ユーザーとボットの**表面発話**のみ。ジャッジ・ツール結果は含めない |
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
  "chatModel": "gemma4:31b",
  "embedModel": "nomic-embed-text:latest",
  "ollamaHost": "http://192.168.16.1:11434"
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

1. **プリプロセス** → `TurnContext` 更新（トークン超過時は要約）
2. **ジャッジくん** → `withJudge` で `JudgeOutput` を載せる
3. **行動くん**（`ACTION.kind !== "none"` のみ）→ `withAction` で `ActionOutcome` を載せる
4. **言語野くん**（`shouldRunLanguage(ctx)`）→ `withPersona` / `withSpeech`
5. **内省くん**（`shouldPersistIntrospection(ctx)`）→ `introspection: string` → エピソード追記
6. **State 更新** `state = NEXT_STATE`
7. **`TurnContext` 破棄**

ハートビート拡張:
- `REPLY === false` でも ACTION 成功時は言語野が独り言を生成する
- idle heartbeat（ACTION なし・REPLY false・speech なし）は内省スキップ

### 4.3 作業記憶の更新

- `REPLY === true` かつ `speech` 非空: ボット発話を append
- `user_message` トリガー: ユーザー発話を append
- `REPLY === false`: ボット行は追加しない
- プロンプト漏洩などで作業記憶が汚染されたときは `data/state.json` の `workingMemory` を `[]` に戻してリセットする

## 5. ジャッジくん

### 5.1 出力スキーマ（Zod）

```typescript
{
  ACTION: { kind: ActionKind; intent: string } | null;
  REPLY: boolean;
  NEXT_STATE: string;
}
```

`kind: "none"` のとき `intent: ""`。パース後は `NONE_ACTION` に正規化。

### 5.2 LLM 呼び出し

- MUST: Ollama chat + `format` = 上記 JSON Schema
- MUST: `temperature: 0`
- パース失敗時: 同一リクエストを最大 1 回再試行
- 再試行後も失敗: `{ ACTION: null, REPLY: true, NEXT_STATE: <現state> }` とし raw をログ

### 5.3 プロンプト制約

- ロールプレイ禁止、3 フィールドのみ

## 6. 行動くん

### 6.1 起動条件

`JudgeOutput.ACTION.kind !== "none"`

### 6.2 サブモジュール（v0.4）

| kind | サブモジュール | 機械処理 |
|------|----------------|----------|
| `remember` | 覚えるくん | LanceDB append |
| `recall` | 思い出すくん | LanceDB vector search |
| `memo_write` | メモを書くくん | `data/notes/` write |
| `memo_read` | メモを読むくん | list / read ファイル |

**記憶 vs メモ**: エピソード（LanceDB）の想起・`recall` は LLM 要約でふんわり提示してよい。メモ（`data/notes/`）は読み出し時に本文を要約・改変せず全文を `facts.body` に載せる。

行動くん本体は薄いディスパッチ。入力は `RunActionInput { ctx, episodes, episodeRecallTopK }` で `TurnContext` から導出。

### 6.3 ActionOutcome

```typescript
type ActionFacts =
  | { kind: "memo_read"; filename: string; body: string }
  | { kind: "memo_write"; filename: string; body: string }
  | { kind: "remember"; body: string }
  | { kind: "recall"; bullets: string[] };

type ActionOutcome = { attempted: false } | {
  attempted: true;
  kind: ActionKind;
  intent: string;
  status: "succeeded" | "failed";
  facts?: ActionFacts;   // succeeded 時（構造化事実）
  summary: string;       // verbose 用。成功時は facts から生成
  error?: { code: string; message: string; detail?: string };
};
```

言語野・内省は `facts` を `action/present.ts` 経由で参照。`summary` の regex 再パースは行わない。

## 7. 言語野くん

### 7.1 起動条件

`shouldRunLanguage(ctx)` — 通常は `ctx.reply === true`。heartbeat では ACTION 成功時も起動。

### 7.2 入力

- `renderLanguageUserContent(ctx)` — `memorySnapshot(ctx)` と同じ事実フィールドを参照
- **今ターンの行動結果** — `formatActionForLanguage(ctx.action)` が `facts` から事実文を組み立て（一人称は載せない。口調は character.md）
- `ctx.persona`（`persona/character.md`）

### 7.3 出力

- CLI に表示するセリフ 1 件（非ストリーム MVP）

## 8. 内省くん

### 8.1 入力組み立て（`renderIntrospectionPrompt(ctx)`）

固定テンプレート。`ctx.judge` オブジェクトは参照しない（`ctx.reply` を使用）。

**状況行**

- `（状況: {state} / {currentDateTime}）` — ターン開始時の State と日本語日時

**会話ブロック**

- `formatWorkingMemoryChannel(ctx)` — 直近の会話（相手の今ターン発話を含む）

**発話ブロック**

- `【いま自分が言ったこと】` — `ctx.speech` あり: 生成した `speech`
- `ctx.reply === false` かつ speech なし: `（返答はしなかった）`

**行動ブロック**（`ctx.action.attempted` のときのみ）

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
- エピソード想起: 直近ユーザー発話（なければ空文字）で embed → top-k → 距離分類 → `summarize`/`vague` は LLM が作業状況に照らして提示文を生成（無関係なら省略）
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
| T-J01 | 有効なジャッジ JSON をパースできる |
| T-J02 | パース失敗後のフォールバック |
| T-I01 | REPLY=false → 発話固定文 |
| T-I02 | ACTION=null → 行動ブロックなし |
| T-I03 | ACTION+成功 → 「できた」 |
| T-I04 | ACTION+失敗 → 「できなかった」 |
| T-T01 | ターン終了後に TurnContext が破棄される（`getTurnContext()` が null） |
| T-W01 | 作業記憶にジャッジ出力が入らない |

## 12. 将来（本 SPEC の範囲外）

- 言語野ストリーミング
- 行動くんの分岐（SNS / ファイル / 予定）
- State 別エピソードフィルタ
- 意味記憶・外部センサー
- 本格 MCP サーバプロセス接続
