# 振る舞い仕様書（SDD）

CONCEPT.md v0.4 と [DECISIONS.md](./DECISIONS.md) に基づく実装契約。テストは本書の MUST 節を根拠に書く。

## 1. 用語

| 用語 | 意味 |
|------|------|
| ターン | トリガー 1 回につき 1 回完結する処理単位 |
| コンテキスト | 揮発。プリプロセス出力。ターン終了で破棄 |
| 作業記憶 | ユーザーとボットの**表面発話**のみ。各エージェントの判断・ツール結果は含めない |
| affect | 持ち越す生の感情（余韻）。旧 `innerState`。`data/state.json` に永続化。空 = 起きたて |
| concern | 認知的焦点（何に注目しているか）。`data/state.json` に永続化。actor activate・recall クエリに使う。空 = 特に焦点なし |
| ToolLog | ターン内のみ保持。言語野くん向け。内省くんには渡さない |

## 2. State

- 既知ラベル: `対話` | `静穏`
- `NEXT_STATE` は検証せず代入する
- 未知値: `console` ログに `unknown_state` として記録し、その値のまま保持

## 3. 設定（`config/settings.json`）

実際の値は `config/settings.json` が正。主要キーの意味のみ示す。

| キー | 説明 |
|------|------|
| `workingMemoryTurns` / `stateConfig[S].workingMemoryTurns` | 作業記憶の保持ターン数 |
| `episodeRecallTopK` / `stateConfig[S].episodeRecallTopK` | 自動想起の件数上限（State 別に上書き可） |
| `recencyExclusionTurns` | エピソード想起から除外する直近ターン数 |
| `recallDistance.fullMax/summarizeMax/vagueMax` | 想起グラデーション閾値 |
| `chatModel` | language / 内省 / 内心 の既定モデル |
| `actionModel` | activator + 全 actor の既定モデル |
| `actors[name].channels` | actor の知覚チャンネル（activator と揃える必要あり） |
| `stateConfig[S].actors` | State 別の有効 actor リスト |
| `roles[name].model` / `.think` | ロール別モデル上書き |

環境変数 `OLLAMA_HOST` があれば `ollamaHost` より優先。

環境変数 `OLLAMA_HOST` があれば `ollamaHost` より優先。

## 4. ターン処理（オーケストレータ）

### 4.1 トリガー

| 種別 | 入力 | 備考 |
|------|------|------|
| `user_message` | 発話文字列 + `speakerId` | State は変更しない（現 State のまま） |
| `heartbeat` | なし | `/heartbeat` 相当 |

### 4.2 フェーズ順（固定）

1. **プリプロセス** → 想起クエリ決定 → エピソード/意味記憶/memoIndex 想起 → `TurnContext` 生成（`stateConfig` でフィルタ量決定。元データ変更なし）
   - 想起クエリ: `lastUserContent → lastSpeech → concern → affect → null`。null のとき recall 系全スキップ
2. **actor pool**（各 actor 並列）→ 各 actor が `activate()` で起動判断し、起動した actor が実行 → `ctx.actions` に追加
   - `activate()` の入力: mini-context（直近 `ACTOR_CONTEXT_TURNS=3` ターン + 最新発話 + 内心）
3. **language-agent** → 全 facts を受け取り発話生成 + NEXT_STATE 出力 → `ctx.speech` / `ctx.nextState` を設定
4. **内省くん**（`shouldPersistIntrospection(ctx)`）→ `introspection: string` → エピソード追記
5. **内心更新**（内省と同条件）→ `updateAffectAndConcern` で `affect` と `concern` を書き換え（`prevAffect` は1文に圧縮して渡す。`prevConcern` は1文のまま渡す）→ `data/state.json` に永続化
6. **State 更新** `state = ctx.nextState`
7. **`TurnContext` 破棄**

idle heartbeat 判定:
- トリガーが `heartbeat` かつ **succeeded なアクションが0件** かつ `ctx.speech` が空 → 内省・内心更新をスキップ
- `shouldRunLanguage` は廃止。language-agent は常に起動し発話するかを内部で判断する

### 4.3 作業記憶の更新

- `ctx.speech` が非空: ボット発話を append
- `user_message` トリガー: ユーザー発話を append
- `ctx.speech` が空: ボット行は追加しない
- プロンプト漏洩などで作業記憶が汚染されたときは `data/state.json` の `workingMemory` を `[]` に戻してリセットする

## 5. actor pool（v0.7〜）

各ツールが独立した actor として並列に自律実行する。memory-agent / research-agent の束ねは廃止。

### 5.1 actor 一覧

| actor | 機械処理 |
|-------|----------|
| `recall` | LanceDB ベクトル検索 |
| `remember` | LanceDB append |
| `forget` | LanceDB ソフト削除（`deleted` フラグ） |
| `memoWrite` | `data/notes/` write |
| `memoRead` | list / read（冒頭抜粋インデックスで pick） |
| `webSearch` | MCP 経由 Web 検索 |
| `urlBrowse` | MCP 経由 URL 閲覧 |
| `webcam` | カメラ映像取得 |

### 5.2 `activate()` スキーマ（共通）

```typescript
{ active: false }
| { active: true; intent: string; time_range?: { since_days_ago?: number; until_days_ago?: number } }
```

- MUST: Ollama chat + `format` = 上記 JSON Schema
- パース失敗・リトライ失敗 → `null`（起動しない）にフォールバック
- 全 actor が `createActivate(name, description)` ファクトリで生成した共通実装を使う

### 5.3 ActionOutcome（共通型）

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

`ctx.actions: ActionOutcome[]` に actor pool の実行結果を順不同で追加。`summary` の regex 再パースは行わない。

## 7. language-agent（言語野）

### 7.1 起動条件

毎ターン必ず起動。`shouldRunLanguage` は廃止。発話するかどうかは LLM が内部で決める。

### 7.2 入力

- `renderLanguageUserContent(ctx)` — `memorySnapshot(ctx)` と同じ事実フィールドを参照
- **`## いまの内心`** — `affect` が非空のときのみ。温度の素として味わい、同じ内容を言い直さない（台本にしない）
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
  tags: string[];
  state: string;          // ターン開始時の State
  action: string;         // フォーマット済みアクションサマリ。なければ空文字
  source: "remember" | "introspection";
  reply: boolean;
  turnId: string;
  importance?: number;    // 重要度 1-10。内省 LLM が採点。未設定時は 5 扱い
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
| T-M01 | ~~memory-agent: 有効な `{activate, tool, intent}` JSON をパースできる~~ （v0.6 廃止） |
| T-M02 | ~~memory-agent: パース失敗後のフォールバック（`activate: false`）~~ （v0.6 廃止） |
| T-R01 | ~~research-agent: 有効な `{activate, tool, intent}` JSON をパースできる~~ （v0.6 廃止） |
| T-R02 | ~~research-agent: パース失敗後のフォールバック（`activate: false`）~~ （v0.6 廃止） |
| T-L01 | language-agent: `speech` 空 → 発話なし（`ctx.speech` 空文字） |
| T-I01 | 内省: `ctx.speech` 空 → 発話固定文 |
| T-I02 | 内省: `ctx.actions` 空 → 行動ブロックなし |
| T-I03 | 内省: action 成功 → 「できた」 |
| T-I04 | 内省: action 失敗 → 「できなかった」 |
| T-T01 | ターン終了後に TurnContext が破棄される（`getTurnContext()` が null） |
| T-W01 | 作業記憶に各エージェントの判断出力が入らない |
| T-WS01 | webSearch activate: `active:true` → intent を返す |
| T-WS02 | webSearch activate: `active:false` → null を返す |
| T-WS03 | webSearch activate: パース失敗 2 回 → null を返す |
| T-WS04 | webSearch activate: システムプロンプトに指示ベース・内心ベース両方の記述がある |
| T-WS05 | webSearch activate: コンテキストに `inner_state` チャンネルの内容が含まれる |
| T-IS01 | `updateAffectAndConcern`: `{affect: string, concern: string}` を返す |
| T-IS02 | `updateAffectAndConcern`: `prevConcern` がプロンプトに含まれる |
| T-IS03 | `data/state.json` の永続化: `affect` と `concern` フィールドを持つ（`innerState` は存在しない） |
| T-IS04 | `buildRecallQuery` heartbeat: concern が非空なら concern を返す（affect より優先） |
| T-IS05 | actor activate コンテキスト（inner_state チャンネル）に concern が含まれる |

## 12. 将来（本 SPEC の範囲外）

- 言語野ストリーミング
- 行動くんの分岐（SNS / ファイル / 予定）
- State 別エピソードフィルタ
- 意味記憶・外部センサー
- 本格 MCP サーバプロセス接続
