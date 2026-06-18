# 振る舞い仕様書（SDD）

CONCEPT.md v0.5 と [DECISIONS.md](./DECISIONS.md) に基づく実装契約。テストは本書の MUST 節を根拠に書く。

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

- 既知ラベル: `対話` | `静穏` | `集中`（集中=取り組み中の計画を進めるモード。計画チャンネルが常駐）
- **State は言語野の宣言でなく観測事実から機械導出する**（`src/orchestrator/turn.ts`）: `user_message` → `対話`（集中は中断されここへ戻る）／ heartbeat で取り組み中の `focusPlan` があれば → `集中`／ それ以外 → `静穏`。言語野は State を出力しない（旧 `NEXT_STATE` 出力は廃止）
- 集中の制御: `focusStreak` が `MAX_FOCUS_STREAK`(=10) に達したら強制ギプス（focusPlan を手放し休む）／進捗が `MAX_FOCUS_STALL`(=6) 伸びなければ見限り（retired）。DECISIONS §集中モード

## 3. 設定（`config/settings.json`）

実際の値は `config/settings.json` が正。主要キーの意味のみ示す。

| キー | 説明 |
|------|------|
| `workingMemoryTurns` / `stateConfig[S].workingMemoryTurns` | 作業記憶の保持ターン数 |
| `episodeRecallTopK` / `stateConfig[S].episodeRecallTopK` | 自動想起の件数上限（State 別に上書き可） |
| `recencyExclusionTurns` | エピソード想起から除外する直近ターン数 |
| `recallDistance.fullMax/summarizeMax/vagueMax` | 想起グラデーション閾値 |
| `chatModel` | language / 内省 / 内心 の既定モデル |
| `actionModel` | 全実行 actor の既定モデル |
| `activatorModel` | actor の起動判断（`activate`）が使うモデル。未設定は `actionModel`。実行モデルと分離して軽量に保てる |
| `ollamaMaxConcurrency` | 全 LLM 呼び出し（chat/embed）のプロセス全体での同時実行上限。サーバの `OLLAMA_NUM_PARALLEL` と揃える（コード既定2・`config/settings.json` は 4 を明示＝実効4。`src/llm/limit.ts`） |
| `imageFeedSource` | 視覚センサー（`image_feed` チャンネル）の出どころ。画像ファイルパス or ディレクトリ（最新1枚）。未設定=視覚オフ。生のまま文字起こしせず言語野に渡す（`src/sensor/frame.ts`・[ARCH-NEXT.md](ARCH-NEXT.md)） |
| `imageMaxLongSide` | 取り込んだ画像の縮小上限（長辺・px・未設定は 1024）。高解像度はタイル増でトークン爆発するので取り込み口（Slack/センサー）で縮小（`src/sensor/image.ts`） |
| `actors[name].channels` | actor の知覚チャンネル（activate と揃える必要あり） |
| `actors[name].model` | actor 実行モデルの個別上書き |
| `stateConfig[S].actors` | State 別の有効 actor リスト |
| `roles[name].model` / `.think` | ロール別モデル上書き（language / introspection / affect） |

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
3. **language-agent** → 全 facts を受け取り発話生成 → `ctx.speech` を設定（State は出力しない）
4. **内省くん**（`shouldPersistIntrospection(ctx)`）→ `introspection: string` → エピソード追記
5. **内心更新**（内省と同条件）→ `updateAffectAndConcern` で `affect` と `concern` を書き換え（`prevAffect` は1文に圧縮して渡す。`prevConcern` は1文のまま渡す）→ `data/state.json` に永続化
6. **State 更新**（機械導出）: `user_message`→`対話`／heartbeat+`focusPlan`→`集中`／他→`静穏`。集中の入口（計画前進で focusPlan 確定）・強制ギプス・見限りもここで処理
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

各ツールが独立した actor として並列に自律実行する。memory-agent / research-agent / カテゴリ・サブエージェントの束ねは廃止（dead-in-prod コードも 2026-06 に削除済み）。

### 5.1 actor 一覧

| actor | 機械処理 |
|-------|----------|
| `memory` | **受動の記憶 faculty**（recall+forget 統合・B'）。activate が op∈{想起=recall / 忘却=forget} を1判断で選び run が振る。想起＝LanceDB ベクトル検索／忘却＝softDelete（`deleted` フラグ・**`id` 列で引く**）。ActionFacts kind は `recall`/`forget` |
| `memo` | **能動の記録 faculty**（notes の full CRUD）。`data/notes/` 読み書き統合。locate（主=recall認識・フォールバック=連想ディセント）で対象を辿り（read-before-edit・**行番号付きで提示**）、op を1つ（view/create/append/replace/section_replace/**replace_line**/**delete_line**）を純関数 applier で適用。MOC ツリー再生成・サイズ自動分割を含む（[MEMO-TREE.md](MEMO-TREE.md)） |
| `webSearch` | MCP 経由 Web 検索 |
| `urlBrowse` | MCP 経由 URL 閲覧 |
| `webcam` | カメラ映像取得（未実装） |
| `plan` | 構造化plan（`data/plans/<id>.json`）を op で更新（コードが構造を保証・LLM は op を1つ出すだけ）。markdown は派生ビュー |
| `synthesize` | 想起＋外部＋感性（内心/関心事）を統合して成果物（歌詞・読書メモ・まとめ・文章）を**生成**し `data/notes/works/<planId\|slug>.md` へ append 外化（生成が役割の唯一のレーン・memo は転記） |

`remember` は**廃止・完全削除**。意図的な内部記憶は「LanceDB への書き込み」でなく、importance 採点（**内心更新 affect と同じ呼び出しで採点**＝§内省の見える範囲・相手を気にかけた発話ほど高く＝残りやすく）で扱う（人間も記憶を直接書けず符号化強度を上げるだけ、という整理）。`EpisodeSource "remember"` は履歴エピソード用に温存。

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
  | { kind: "research"; tool: string; title: string; summary: string; body: string }
  | { kind: "express"; tool: string; title: string; body: string }
  | { kind: "synthesize"; filename: string; body: string }
  | { kind: "plan"; planId: string; filename: string; body: string; achieved: boolean };

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
{ speech: string }
```

`speech` が空文字のとき発話なし（`ctx.reply = false`）。**State は言語野が出力しない**（§2・§4.2 で観測から機械導出）。旧 `nextState` フィールドは廃止＝`parseLanguageOutput` は壊れた出力に紛れ込む `nextState` の痕跡を除去するだけ。

### 7.4 出力

- `ctx.speech` に格納し CLI に表示（非ストリーム MVP）
- State 遷移は言語野でなくオーケストレータが観測から導出（§4.2 phase 6）

## 8. 内省くん

### 8.1 入力組み立て（`buildReflectionMessages(ctx)`）

**role 構造のマルチターン**で渡す（フラットなテキスト1枚ではない）。自他境界を role で示し、小型モデルでの取り違えを防ぐ。各エージェントの判断プロセスは参照しない（`ctx.speech` と `ctx.actions` のみ使用）。

- `system`: `INTROSPECTION_SYSTEM` + `（状況: {state} / {currentDateTime}）`
- **会話**: これまでのやり取りを role 構造で渡す（相手=`user` / 自分=`assistant`、独り言も `assistant`）。このターンの相手発話も `user` として末尾に積む
- **自分の動き（`assistant`）**: このターンの行動の事実（`（行動）{ラベル} — {intent}` + `formatActionForIntrospection`）と `ctx.speech`（空なら `（返答はしなかった）`）を1つの `assistant` メッセージに
- `user`: 「上のやり取りを振り返り一人称の内省を書く」指示

`status === succeeded` → `できた`、`failed` → `できなかった`。内省 LLM の実メッセージは `--verbose`（debug）で確認できる。

> 旧 `renderIntrospectionPrompt`（フラット固定テンプレ）は廃止。同様に内心更新・`memo` も自他（誰が誰に言った/頼んだか）を明示する（`memo` はフラット＋方向ラベル、内省/内心は role 構造）。

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
  importance?: number;    // 重要度 1-10。内心更新（affect）と同じ呼び出しで採点（DECISIONS §内省の見える範囲）。未設定時は 5 扱い
}
```

## 9. プリプロセス

- センサー: システム時刻（ISO8601）を常に含める
- 作業記憶: 直近 `workingMemoryTurns` 件
- エピソード想起: 直近ユーザー発話（なければ空文字）で embed → top-k → **直近 `recencyExclusionTurns` ターンの turnId を除外**（`excludeTurnIds`）→ 距離分類（`full`/`summarize`、`summarizeMax` 超は `omit`）→ `summarize` は LLM が作業状況に照らして提示文を生成（無関係なら省略）
- 計画チャンネル: `state==="集中"` かつ `data/state.json` の `focusPlan`（取り組み中 plan id）があれば、`data/plans/<id>.json` を `renderPlan` して `ctx.plan` に載せ言語野・plan チャンネル actor に常駐注入。集中以外は空
- トークン超過時（`fitTurnContext`）: 先に作業記憶の古いターンを削り、なお超過なら chatModel（既定 35B）で**想起エピソードのみ**を要約（失敗時のみ機械切り詰め）

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

- `npm run heartbeat`: 1 ターンだけ heartbeat。`npm run say -- "…"`: 1 ターンだけ user_message（既定話者 `claude_kuro`）
- ログ 3 段階: `-v`/`--verbose`=debug（全 LLM 入出力）、`-q`/`--quiet`=サマリなし、無指定は REPL=quiet・常駐=info（1ターン十数行サマリ）
- `config/users.yaml` の `note`（任意）は言語野の `## 相手について` に注入される

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
| T-WS04 | webSearch activate: システムプロンプトが単一軸（外界の事実が要るか）で判定を述べる |
| T-WS05 | webSearch activate: コンテキストに `inner_state` チャンネルの内容が含まれる |
| T-IS01 | `updateAffectAndConcern`: `{affect: string, concern: string}` を返す |
| T-IS02 | `updateAffectAndConcern`: `prevConcern` がプロンプトに含まれる |
| T-IS03 | `data/state.json` の永続化: `affect` と `concern` フィールドを持つ（`innerState` は存在しない） |
| T-IS04 | `buildRecallQuery` heartbeat: concern が非空なら concern を返す（affect より優先） |
| T-IS05 | actor activate コンテキスト（inner_state チャンネル）に concern が含まれる |
| T-FS01 | State 導出: user_message は focusPlan があっても `対話` に割り込む（集中の中断・focusPlan は保持） |
| T-FS02 | State 導出: heartbeat + focusPlan あり → `集中`、focusStreak 加算 |
| T-FS03 | State 導出: heartbeat + focusPlan なし → `静穏`、focusStreak リセット |
| T-FS04 | 強制ギプス: focusStreak が MAX_FOCUS_STREAK(=10) で focusPlan を手放し `静穏` |

## 12. 将来（本 SPEC の範囲外）

- 言語野ストリーミング
- 行動くんの分岐（SNS / ファイル / 予定）
- State 別エピソードフィルタ
- 意味記憶・外部センサー
- 本格 MCP サーバプロセス接続
