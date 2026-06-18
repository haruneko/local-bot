# Ollama → Google Vertex AI 移行スコーピング

調査日: 2026-06-18 / 読み取り専用調査（コード・config・data は未変更）。
裏取り済みファイルは `file:line` を併記。憶測は「要確認」と明記した。

---

## ① アダプタ境界の現状評価（綺麗 / 漏れ）

### チャット側（LlmClient）はほぼ綺麗

- 抽象は `src/llm/types.ts`：`LlmClient.chat(messages, options) => Promise<string>` の1メソッドだけ。`ChatMessage`（role/content/images）と `ChatOptions`（format / temperature / numPredict）も**ベンダ中立な型**になっている。
- 全ロール・全 actor・内省・activator は `LlmClient` 型を受け取って `.chat()` を呼ぶだけ（`src/roles/*`, `src/actors/*`）。`OllamaLlmClient` 具象に依存しているのは構築箇所（bootstrap・一部 CLI）のみ。
- ロギングデコレータ `withVerboseLlm`（`src/llm/logging.ts`）も `LlmClient` を実装して返すので、Vertex 実装にもそのまま被せられる。
- `src/llm/limit.ts` の `runLimited` / `withLlmRetry` はコメント（`limit.ts:6`「クラウド client に差し替えても同じ runLimited を通せばよい」）どおり**プロバイダ非依存**で設計済み。

結論: **チャットは「`VertexLlmClient implements LlmClient` を1クラス足す」だけで大半が済む。** ただし下記の漏れ・非互換が4点ある（②③参照）。

### 漏れ・抽象を貫通している Ollama 固有部分

1. **`think` が `LlmClient` の外（コンストラクタ config）にある。** `OllamaClientConfig.think`（`ollama.ts:10`）で渡され、`chat()` 内で `this.config.think ?? false` を Ollama API へ直接渡す（`ollama.ts:38`）。型 `OllamaThinkSetting`（`config/settings.ts:10`）は `boolean | "high" | "medium" | "low"` で、これは Ollama think API の語彙そのもの。Vertex に等価機能を当てるなら設定の意味づけを再定義する必要（要確認: Gemini の thinking budget / Claude on Vertex の extended thinking へのマッピング）。
2. **`numCtx`（`ollamaNumCtx`）も config 経由で Ollama `options.num_ctx` に直行**（`ollama.ts:41`）。クラウドは固定コンテキスト長なのでこの概念が無い（②参照）。
3. **埋め込み抽象が存在しない＝最大の漏れ。** stores（`src/memory/lancedb.ts:49,54` ほか semantic / memo_index）が**具象 `OllamaEmbedClient` を直接 import・型注釈**している。`EmbedClient` インターフェイスが切られていないので、Vertex 埋め込みを足すには新規インターフェイス抽出が必須（③参照）。
4. **横断 embedding（ImageBind）は別系統で独立**（`src/embedding/xmodal.ts`）。`XmodalEmbedder` インターフェイスは既にあり Ollama 非依存（HTTP 直叩き）。Vertex 移行では原則そのまま（既定 OFF）。ただし dim 1024 固定で LanceDB の `episodes_xmodal` テーブルに紐づく点に注意。

### `OllamaLlmClient` 構築箇所（全列挙）

| 箇所 | 用途 |
|------|------|
| `src/app/bootstrap.ts:103` | ロール用 LLM（language/introspection/affect ループ） |
| `src/app/bootstrap.ts:144` | メイン `llm`（chatModel） |
| `src/app/bootstrap.ts:156` | `actionLlm`（actionModel・activator/全 actor 共用） |
| `src/app/bootstrap.ts:172` | `activatorLlm`（activatorModel が別の時のみ） |
| `src/app/bootstrap.ts:264` | actor 個別モデル（actionModel と異なる時のみ） |
| `src/cli/score-importance.ts:33` | importance 採点 CLI |
| `scripts/smoke-ollama.ts:10` | 疎通確認 |

`OllamaEmbedClient` 構築箇所：`bootstrap.ts:194` / `cli/notes-rm.ts:35` / `cli/score-importance.ts:34` / `cli/reindex.ts:12` / `cli/eval-retrieval.ts:54` / `scripts/reembed-tables.mts:14` / `scripts/episode-graded-ndcg.mts:15` / `scripts/smoke-ollama.ts:20`。

---

## ② チャットの非互換点（変更必要箇所一覧）

### 構造化出力 `options.format`（最重要・影響範囲が広い）

`format` は **zod → `zodToJsonSchema`（`$refStrategy:"none"`）で生成した JSON Schema オブジェクト**を、Ollama の `format`（`string | object`、`node_modules/ollama/dist/shared/ollama.415fa141.d.ts:49,97`）にそのまま渡す方式。`format:"json"`（裸の json モード）は**現状どこも使っていない**（grep で 0 ヒット）。schema を渡している全箇所：

| 箇所 | スキーマ |
|------|----------|
| `src/roles/introspection.ts:42` | `introspectionSchema`（内省 text） |
| `src/roles/introspection.ts:72` | `tagsSchema`（エピソードタグ） |
| `src/roles/inner-state.ts:119` | `affectConcernSchema`（affect/concern＋importance採点） |
| `src/roles/memo.ts:99` | `opFormat`（memo の op） |
| `src/actors/activate.ts:59` | `activateOutputSchema`（actor 起動判定） |
| `src/actors/memory.ts:52` | `memoryActivateJsonSchema`（recall/forget 判断） |
| `src/cli/score-importance.ts:54` | `importanceJsonSchema` |

**マッピング設計:**
- **Gemini on Vertex**: `generationConfig.responseMimeType="application/json"` ＋ `responseSchema`。ただし Gemini の `responseSchema` は **OpenAPI 3.0 Subset** で、`zodToJsonSchema` の出力（JSON Schema Draft-07・`$schema`/`additionalProperties`/`$ref` 等を含む）と**そのまま互換ではない**。`$refStrategy:"none"` で `$ref` は潰してあるが、`responseSchema` が受け付けないキー（`$schema`, `additionalProperties`, `definitions` 等）を**剥がす変換層が要る**（要確認: 実際に弾かれるキーは Vertex の SDK バージョン依存）。
- **Claude on Vertex（Anthropic）**: ネイティブな `responseSchema` は無く、**tool-use（`tools` ＋ `tool_choice` 強制）で構造化を実現**するのが定石。`chat()` の戻り値は `string`（JSON テキスト）なので、tool 呼び出し結果の input を JSON 文字列にシリアライズして返すアダプタ実装にすれば呼び出し側は無改修で済む。

**緩和材料（朗報）:** 全呼び出し側が `tryParseJsonWithSchema`（`src/action/parse-json.ts`）経由で、コードフェンス除去・`<think>` 除去・JSON 修復・過剰エスケープ救済まで備える。`introspection.ts:48` のように**パース失敗時の生テキストフォールバック**もある。つまり構造化出力が完璧でなくても**裸 JSON モード（`responseMimeType` のみ・schema 無し）でも実用上は通る公算が高い**＝最小移行では schema 変換を後回しにできる（要確認: activate/memo の厳密 op は schema 無しだと精度低下リスク）。

### `think` パラメータ

- 現状 `think:false` が大半（settings は `ollamaThink:false`、actor/activator は強制 `think:false`）。Ollama 固有 API。
- 移行方針: `ChatOptions` または client config に**プロバイダ中立な thinking 概念**を再定義。Gemini なら thinking budget、Claude on Vertex なら extended thinking。**最小移行では「無効固定」で落としても挙動はほぼ変わらない**（現に全レーン false）。`<think>` 除去ロジック（`parse-json.ts:9`）はクラウドでは基本不要になるが、残しても無害。

### `num_ctx`（`ollamaNumCtx:30000`）

- Ollama 固有（モデルの KV キャッシュ長を起動時に指定）。Vertex は**コンテキスト長がモデル固定**（Gemini 1M 級、Claude 200K 級）なので**この設定は破棄**してよい。
- 注意: 現状 `ollamaNumCtx:30000` は qwen を**意図的に絞っている**値。Vertex の広いコンテキストに移ると、`contextTokenBudget`（`config/settings.ts`）側のトリム設計が実質効かなくなる可能性。コスト/レイテンシ観点で `contextTokenBudget` の見直しが要る（要確認）。

### `temperature` / `num_predict`（numPredict）

- `temperature`: 既定 0.7（`ollama.ts:40`）、構造化呼び出しは 0。Gemini・Claude on Vertex とも `temperature` あり＝**素直にマップ可**（ただし値域・既定が違うので要確認。Claude は 0-1、Gemini は 0-2）。
- `numPredict`（= Ollama `num_predict`、`ollama.ts:42`）→ Gemini/Claude の **`maxOutputTokens` / `max_tokens`** にマップ。`languageNumPredict:400`（`bootstrap.ts:298`）等で使用。**`-1`（無制限）は Vertex に無い**ので、未指定時はモデル上限 or 適当な大きい値に読み替える変換が要る。

### `images`（マルチモーダル）

- `ChatMessage.images: string[]`（base64）。Ollama は messages 内に直接渡す。webcam/vision で使用（`turn.ts:328`, `slack.ts`）。
- Gemini/Claude on Vertex とも画像入力は**メッセージ part の構造が違う**（Gemini: `inlineData{mimeType,data}`、Claude: `image` block）。アダプタ内で `images[]` を各 API 形式の part へ変換する必要。**現状 vision を使う actionModel は `qwen3-vl:8b` なので、移行先モデルも vision 対応必須**（Gemini は全対応、Claude on Vertex も対応）。

---

## ③ 地雷 = 埋め込み移行（最重要）

### なぜ地雷か

1. **抽象が無い。** stores は `OllamaEmbedClient` 具象に型依存（`lancedb.ts:49,54` / `semantic-lancedb.ts:55,60` / `memo-index-lancedb.ts:47,52`）。Vertex 埋め込みを足すには `EmbedClient` インターフェイス（`embedQuery` / `embedDocument` / `embed`）を抽出し、3 stores ＋ 8 構築箇所を全て差し替える必要。
2. **次元が変わる＝全テーブル作り直し必須。** LanceDB テーブルは作成時に最初の `embedder.embed("init")` の戻り次元で schema が固定される（`lancedb.ts:70-71`、semantic/memo_index も同型）。ruri-v3 = **768 次元**。Vertex の `gemini-embedding-001` は既定 **3072 次元**（出力次元の縮約は可・要確認）、`text-embedding-005` 等は **768**。**768 を選べば schema 互換だが、`reembed-tables.mts` のコメント（`reembed-tables.mts:2`「768→768 で schema 互換」）が示す通り、それでもベクトル中身は別物なので全行 re-embed は必須。** 768 以外を選ぶと既存テーブルは開けず**ドロップ＆再生成**になる。
3. **タスク接頭辞仕様が違う。** `src/llm/embed-prefix.ts` は ruri/nomic/e5 のテキスト接頭辞（ruri は非対称「検索クエリ:」/「検索文書:」）をモデル名で分岐。**Vertex 埋め込みは接頭辞ではなく API パラメータ `task_type`**（`RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT`）でクエリ/文書を区別する。つまり「テキストに文字列を前置きする」現行モデルは Vertex では**間違い**＝`embedPrefixFor` を Vertex モデルに対しては空にし、代わりにアダプタ内で `task_type` を出し分ける設計に変える必要（`OllamaEmbedClient.embedQuery/embedDocument` の責務をそのまま `task_type` 出し分けに置換できる＝インターフェイス形は維持できる）。

### 横断 embedding（ImageBind）への影響

- `XmodalEmbedder`（`src/embedding/xmodal.ts`）は Ollama 非依存・HTTP 直叩き・既定 OFF（settings の `crossmodal.enabled` 未設定）。**Vertex 移行で直接の変更不要。** Vertex のマルチモーダル埋め込み（`multimodalembedding`）に将来寄せる選択肢はあるが本スコープ外。
- dim 1024 固定（`XMODAL_DIM`）の `episodes_xmodal` は本体テーブル（768→新次元）とは独立なので、本体 re-embed の巻き添えにはならない。

### 再 embed 手順（移行時の必須オペレーション）

CLAUDE.md §embed の手順に沿う。Vertex 移行では:

1. `data/lancedb` をバックアップ。
2. `config/settings.json` の `embedModel` を Vertex モデル名へ（＋プロバイダ選択キー。④参照）。
3. **同次元を選んだ場合**: `scripts/reembed-tables.mts`（episodes/semantic を mergeInsert で vector 差し替え）を実行 ＋ `npm run reindex`（memo_index を notes から再生成）。
   - ⚠️ `reembed-tables.mts:14` と `reindex.ts:12` は `OllamaEmbedClient` 直構築なので、**これらスクリプトも Vertex 対応に書き換えが必要**（embed 抽象を通すか、Vertex 用 embedder を直接生成）。
4. **次元が変わる場合**: 既存テーブルを開けないので episodes/semantic/memo_index を**ドロップして再生成**。エピソード本文は LanceDB にしか無い（`data/notes` は memo 本文のみ）ため、episodes の body を吸い出してから作り直す＝`reembed-tables.mts` を「読み出し→新テーブル create→insert」に改造する必要。memo_index は `reindex` で notes から完全再生成できるので問題なし。
5. `npm run eval:retrieval -- --model <vertex-embed>`（`src/cli/eval-retrieval.ts`）で Recall@k/MRR を旧 ruri と横並び比較。**ただし `eval-retrieval.ts:54` も `OllamaEmbedClient` 直構築なので Vertex 対応の改修が要る。**
6. `recallDistance` 閾値（ruri 実測 0.30/0.40/0.48 = `DEFAULT_RECALL_DISTANCE_THRESHOLDS`）は**モデルの距離分布依存**。Vertex 埋め込みは距離分布が違う（コサイン正規化の有無等）ので**測り直して `settings.recallDistance` で再調整必須**。`explicitRecallMaxDistance`（既定 0.45）/ `semanticRecallMaxDistance`（0.75）も同様。

---

## ④ 横断的事項

### 同時実行リミッタ（`limit.ts` / `ollamaMaxConcurrency:4`）

- `runLimited` は単一プロセス内 p-limit。**クラウドは「サーバを溢れさせない」ではなく「レート制限（RPM/TPM）と課金」が制約**になる。`ollamaMaxConcurrency` の意味は残る（並列度の上限として）が、Vertex のクォータ（プロジェクト単位 QPS）に合わせた値へ。設定キー名を `llmMaxConcurrency` 等に中立化するのが望ましい（要確認: 既存値の互換維持）。
- 毎ターン頭の actor 並列起動バーストはクラウドでも有効＝リミッタは残す。

### リトライ（`withLlmRetry` / `isRetriableLlmError`）

- 対象 regex（`limit.ts:27`）は `429/500/502/503/504/overloaded/rate.?limit/fetch failed/ECONNRESET` 等。**Vertex/Anthropic のエラー文言・コードに概ね当たる**（429・503・"overloaded" は Anthropic、"RESOURCE_EXHAUSTED" は Vertex Gemini）。
- ⚠️ Vertex Gemini のレート超過は HTTP 429 だが本文ステータスが **`RESOURCE_EXHAUSTED`** で来ることがある。これは現 regex に当たらない可能性＝**`RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED` を追加すべき**（要確認: 使用 SDK が err.message にどう載せるか）。
- `SLOW_TIMEOUT`（HEADERS/BODY_TIMEOUT 除外）は undici/Ollama 固有。クラウド SDK では別のタイムアウト表現になるので無害だが見直し対象。

### 認証（Vertex は ADC / サービスアカウント）

- 現状の認証は実質ゼロ（`OLLAMA_HOST` の URL だけ、`bootstrap.ts:88`）。**Vertex は新規に必要**:
  - GCP プロジェクト ID・ロケーション（例 `us-central1` / `asia-northeast1`）。
  - 認証は **ADC（`GOOGLE_APPLICATION_CREDENTIALS` でサービスアカウント JSON）** か gcloud ログイン。`.env`（既存で `TAVILY_API_KEY` を置いている）に寄せる方針が自然。
  - Claude on Vertex も同じ GCP 認証経路（Anthropic SDK の Vertex モード or `@anthropic-ai/vertex-sdk`）。
- `OLLAMA_HOST` 相当として `VERTEX_PROJECT` / `VERTEX_LOCATION` 環境変数 ＋ settings キーを足す。

### settings スキーマ（`config/settings.ts`）にプロバイダ選択をどう足すか

- 現状 `AppSettings` はモデル名が**裸の文字列**（`chatModel` 等）でプロバイダ概念が無い。最小侵襲案:
  - `llmProvider?: "ollama" | "vertex-gemini" | "vertex-claude"`（既定 `"ollama"`）を足す。
  - `OllamaThinkSetting` / `ollamaHost` / `ollamaNumCtx` / `ollamaMaxConcurrency` の `ollama` 接頭辞は後方互換のため残しつつ、プロバイダ非依存な別名を導入（または provider ごとの設定ブロックに切る）。
  - `embedModel` も provider に応じて解釈（Vertex モデル名なら接頭辞を空に・task_type 出し分け）。
- `resolveOllamaThink` / `resolveOllamaHost` 等のリゾルバ（`config/settings.ts` / `bootstrap.ts:88`）は provider 分岐を足す形になる。

### `config/mcp.json` への影響

- **影響なし。** MCP（research/browse 等のツール）は LLM プロバイダと独立（`src/mcp/`）。`expressDryRun` も無関係。`config/mcp.json` は触らなくてよい。

---

## ⑤ Vertex 上の選択肢（一段落）

**Gemini on Vertex**（`gemini-2.x`）は `responseSchema`/`responseMimeType` でネイティブ構造化出力ができ（schema は OpenAPI subset 変換が要る）、マルチモーダル（vision）対応、日本語も実用十分、価格は Claude より概して安く本数を多く回す本アプリ（毎ターン多数の activate/actor 呼び出し）と相性が良い。一方 **Claude on Vertex（Anthropic）** は構造化出力を tool-use で実現する必要があり一手間だが、qwen→Claude で日本語の機微・内省/言語野の表現品質が上がる期待があり、`<think>` 系の前処理も不要になる。ただし価格は高めで、本アプリの「軽い activator を大量に回す」設計だとコストが効くため、**言語野/内省は Claude・activator/actor 判定は Gemini Flash と使い分ける**のが現実解になりうる（本アプリは既に role/actor 単位でモデルを分離できる＝`resolveRoleModel`/`resolveActorModel`／要確認: 1プロセスで2プロバイダ混在させる設計を許すかは④のスキーマ設計次第）。

---

## 推奨アプローチ（最小差分でプロバイダ抽象を足す）

1. **チャット**: `VertexGeminiLlmClient` / `VertexClaudeLlmClient`（どちらも `implements LlmClient`）を `src/llm/` に追加。`think`/`numCtx` は client config から落とす（or 中立化）。`format`（zod JSON Schema）→ 各 API へのスキーマ変換と、画像 part 変換をアダプタ内に閉じ込める。呼び出し側（roles/actors）は**無改修**。
2. **埋め込み**: `EmbedClient` インターフェイス（`embedQuery`/`embedDocument`/`embed`）を新設し、`OllamaEmbedClient` をそれに implements させる（後方互換）。`VertexEmbedClient` を追加（接頭辞でなく `task_type` で出し分け）。stores の型注釈（`lancedb.ts:49` 等）を具象 → インターフェイスに置換。
3. **構築の分岐**: `bootstrap.ts` の各 `new OllamaLlmClient`／`new OllamaEmbedClient` を `createLlm(settings, role)` / `createEmbedder(settings)` のようなファクトリに集約し、`settings.llmProvider` で分岐。CLI/スクリプト（score-importance / reindex / reembed-tables / eval-retrieval / notes-rm / smoke）も同ファクトリ経由に寄せる。
4. **settings**: `llmProvider` ＋ Vertex 用キー（project/location）＋ 中立化した concurrency/maxOutputTokens を追加。`ollama*` キーは残置（互換）。
5. **データ移行**: 埋め込みモデル変更に伴う re-embed を③の手順で実施（同次元を選べば `reembed-tables.mts` 改造＋`reindex`、別次元ならテーブル再生成）。`eval:retrieval` で Recall を裏取りしてから `recallDistance` 閾値を再調整。
6. **リトライ**: `isRetriableLlmError` の regex に `RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED` を追加。

**この順なら、チャット移行（1〜4）と埋め込み移行（5）を分離でき、埋め込みは ruri を残したままチャットだけ先に Vertex へ切る段階移行も可能**（embedModel と chatModel は完全に別系統なので相互依存が無い＝裏取り: bootstrap で別々に構築）。
