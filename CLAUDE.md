# CLAUDE.md

このファイルは Claude Code がこのリポジトリで作業するときのガイドです。

## プロジェクト概要

ローカル LLM（Ollama）で動く自宅向け対話エージェント。**実行・言語化・内省を構造的に分離**し、小さいモデルでも破綻しにくくする設計。分離脳の左脳モデルに倣い、言語化と内省は行動の「原因」ではなく「結果」として後付けで生成される。単一の意思決定者（ジャッジ）は存在せず、各エージェントが同一の観測事実（TurnContext）から自律的に判断して動く。

設計思想は [docs/CONCEPT.md](docs/CONCEPT.md)、実装契約は [docs/SPEC.md](docs/SPEC.md)、実装判断は [docs/DECISIONS.md](docs/DECISIONS.md)、行動設計は [docs/ACTION-DESIGN.md](docs/ACTION-DESIGN.md)。コードを変える前に、関連する MUST 節と決定ログを確認すること。

`docs/` 本体が規範＝正本。決定の裏づけ（証拠・eval・監査・調査）は **`docs/research/`**（非規範・引用されたら凍結・[docs/research/README.md](docs/research/README.md)）。記事・発信用の下書きは **`article/`**（gitignore・リポ外）に置く＝docs/research には混ぜない。

## コマンド

```bash
npm run dev          # REPL 起動（= npm start, tsx 実行・build 不要）
npm run heartbeat    # 1 ターンだけ heartbeat して終了（cron 向け）
npm run say -- "メッセージ"        # 1 ターンだけ user_message を送って終了。既定話者=クロ(claude_kuro)
npm run say -- --user user_001 --memory-only "..."  # 話者・使い捨て指定
npm run dream        # 夢バッチ: エピソード/タネを意味記憶へ蒸留
npm run dream -- --seed          # 初回: 夢のタネを蒸留（エピソード 0 件でも可）
npm run dream -- --seed --force-seed  # タネを再蒸留
npm test             # Vitest（LLM 統合テストなし）
npm run test:watch
npm run build        # tsc
npm run smoke        # Ollama 疎通確認
npm run reindex      # data/notes/ を memo_index に再索引（embedModel 変更時は必須・§embed）
npm run notes:rm -- <相対パス>...   # ノート削除を3点セット（ファイル/memo_index/MOC）で。--prune-orphans / --list-orphans
npm run eval:retrieval -- --model <embed>  # 想起評価（自前 gold で Recall@k/MRR 横並び）。--corpus episode で想起も
```

CLI 共通オプション: `-v`/`--verbose`（debug=全文ダンプ）, `-q`/`--quiet`（サマリ無し）, `--user <id>`, `--memory-only`（インメモリ記憶・テスト用）。ログは3段階（`src/util/verbose.ts`）: `quiet`（発話＋state のみ）/ `info`（1ターン十数行の構造化サマリ・stderr）/ `debug`（全 LLM prompt/response・context 全文）。既定は REPL=`quiet`・Slack/heartbeat=`info`。
REPL 内コマンド: `/quit`, `/heartbeat`, `/state <値>`。

## アーキテクチャ

### 認知の構造（ターン全体のパイプライン）

```
[入力] プリプロセス（想起） → [自律] actor pool（並列） → language-agent → 内省 → 内心更新 → LanceDB
```

- **プリプロセス** (`src/context/preprocess.ts`): 想起クエリ決定（`lastUserContent → lastSpeech → concern → affect → null`）→ LanceDB 想起 → `TurnContext` 生成。フィルタは量を絞るだけで元データは変更しない。時刻は知覚チャンネルに **生の日時＋曜日＋時間感覚の言葉（相: 朝/夜更け 等。`phaseOfDay` で決定的に付与。生の時刻だけだとモデルが「感じ」に変換できないため言葉を先に付ける）** として載せる（`src/sensor/datetime.ts`）。
- **actor pool** (`src/actors/`): `memo` `webSearch` `urlBrowse` `webcam` `steps` `synthesize` が独立して並列に起動判断・実行。**想起は actor でなくプリプロセスの背景 recall（常時・機械・concern-aware）＋減衰に一本化**（2026-06-18 に能動 recall actor を撤去＝concern を想起クエリへ合成する (b) 背景 recall に対し能動 recall は上乗せゼロと5パターン実測・[docs/DECISIONS.md](docs/DECISIONS.md) §記憶 faculty）。忘却も意志の op でなく**減衰**（`recencyDecay`×importance＝「意識して忘れる」は人間にない・本気の削除はプライバシー用 out-of-band の `runForget` 温存）。意図的記憶は importance 採点（`remember` 廃止の理屈・`EpisodeSource "remember"` と present は履歴用に温存）。**記録は能動 faculty=`memo`**（notes ファイルの full CRUD）。判断系 actor（memo/webSearch/steps/synthesize）の起動は **multi-label 1発**（`runMultiLabelActivator`・各 actor の `criteria` を同時判定）で決める＝memo/steps/synthesize の三つ巴の過剰発火を joint 判断で抑える（別々判定だと各 gate が他を知らず各自 active と言いがち・実測で別々より正確かつ速い）。urlBrowse は客観ゲート（URL 正規表現・LLM 不要）。mini-context（直近3ターン）で判断。`steps` は集中モードの**構造化steps**（`data/steps/<id>.json`）を op で更新する（構造はコードが保証・LLM は op を1つ出すだけ。markdown は `data/notes/goals/` への派生ビュー）。`memo` は読み書き統合 actor で、locate（主=recall認識・フォールバック=連想ディセント）→対象を全文ロード（read-before-edit・**行番号付きで提示**）→ op を1つ（view/create/append/replace/section_replace/**replace_line**/**delete_line**）を純関数 applier で適用する（[docs/MEMO-TREE.md](docs/MEMO-TREE.md)）。`synthesize` は想起＋外部＋感性（内心/関心事）を統合して成果物（歌詞・読書メモ・まとめ・文章）を**生成**し `data/notes/works/<stepsId|slug>.md` へ append で外化する＝「行動としての思考」。memo（強制ギプス・転記）と違い**生成が役割**の唯一のレーン。「書いて/作って/まとめて」や集中作業の成果物前進で起動。集中中の計画の**前進は steps actor の発火に賭けず**、毎ターン頭の **steps processor（前判定・`src/roles/steps-processor.ts`）**が担う＝成果物(works)と計画を突き合わせ「current は満たされたか」を狭い yes/no で判定し、機械が✓・current 前進・全✓なら締める（steps actor は計画の*作成/編集*が役割に縮小）。doer(synthesize)には**計画全体でなく current マイルストーン1個（`currentTask`）だけ**を渡す＝先走り防止（DECISIONS §集中モード）。計画を扱う faculty 全体（進行係 processor／手 steps actor／目覚まし schedule）の設計は [docs/STEPS-FACULTY.md](docs/STEPS-FACULTY.md)。
- **language-agent** (`src/roles/language.ts`): 全 facts を受け取り発話生成 + NEXT_STATE を出力。常に起動し発話するかを内部で決める。
- **内省** (`src/roles/introspection.ts`) → **内心更新** (`src/roles/inner-state.ts`)。

1ターンの統括は `src/orchestrator/turn.ts`。フェーズ順は固定（SPEC §4.2）。

### TurnContext（最重要の不変条件）

- 1ターン = **1つの `TurnContext`** を全フェーズで使い回し更新する。ターン終了で破棄（永続化は内省→LanceDB のみ）。
- 全エージェント・内省は**同じ事実データ**を参照する。`memorySnapshot(ctx)` 経由。**ロールごとに別フォーマットで入力を組み立てない**。
- 内省は各エージェントの判断プロセスを見ない。`ctx.reply` + `ctx.speech` + `ctx.actions` のみ（ツールログは渡さない）。
- `ctx.actions: ActionOutcome[]`（actor pool の結果を順不同で追加）。`summary` の regex 再パースはしない。
- 行動成功時の構造化事実は `ActionFacts` (`src/action/facts.ts`)、表示は `src/action/present.ts`。

## 記憶の4層（性質が違う・混ぜない）

| 層 | 保存先 | 読み出し時の方針 |
|----|--------|------------------|
| エピソード記憶 | `data/lancedb/` `episodes` | LLM 要約・グラデーション（full/summarize、遠いものは omit）OK＝ふんわり思い出す（旧 vague 段は廃止＝中身ゼロのノイズだった）。内省が毎ターン本文を書く。`importance`（1-10）は**内心更新（affect）と同じ呼び出しで採点**＝生まれたての感情を根拠に符号化強度を決める（内省は感情の前に走るので付けない・DECISIONS §内省の見える範囲）。importance は「気にかけ度」寄り（相手の気持ち・新たに分かった相手のこと・頼まれた等を高く）＝意図的記憶の代替。想起の relevance に効く（減衰に抗う） |
| 意味記憶 | `data/lancedb/` `semantic` | 夢で蒸留した知識。**外界 grounded**＝エピソードからは「相手・世界について実際に語られた／起きた事実」だけ蒸留し、自己物語（「わたしは〜」）はエピソードから作らない（自己像は persona＋夢のタネが正本・話者を取り違えない・推測で埋めない） |
| メモインデックス | `data/lancedb/` `memo_index` | 「どこに何を書いたか」の所在管理。`memo` のメモ書き込み成功時に機械的 upsert。減衰しない |
| 共有メモ本文 | `data/notes/**/*.md` | **本文を LLM で要約しない**（劣化禁止）。構造保存的な op 編集（厳密置換・見出し差し替え）は read-before-edit を条件に可。全文を `facts.body` に載せる。階層ディレクトリ可 |
| 作業記憶 | `data/state.json` | ユーザーとボットの**表面発話のみ**。各エージェントの判断・ツール結果は含めない |
| affect（感情余韻） | `data/state.json` `affect` | 持ち越す生の感情（余韻）。旧 `innerState`。内省後に毎ターン書き換え。空＝起きたて |
| concern（関心事） | `data/state.json` `concern` | 認知的焦点（何に注目しているか）。affect と同じ LLM 呼び出しで更新。actor activate / recall クエリに使う |
| focusSteps（取り組み中の計画） | `data/state.json` `focusSteps` | 集中 State で取り組み中の steps id（`data/steps/<id>.json`）。`state==="集中"` のとき renderSteps して計画チャンネルに常駐注入。**前進は毎ターン頭の steps processor（前判定）が works↔計画照合で✓・current 更新・全✓なら締め**（steps actor は作成/編集役に縮小）。集中の制御は4段（入口/sticky/疲労`focusStreak`/見限り`focusStall`＝進捗ベース卒業で `retired` 化）＝DECISIONS §集中モード |

`memo_index` はエピソード記憶・意味記憶とは別テーブル（情報源記憶）。`episodes` に書かない（DECISIONS.md §メモインデックスの設計 参照）。  
想起グラデーションは `src/recall/distance.ts`（距離分類）+ `src/recall/llm-present.ts`（LLM 提示）。閾値は `DEFAULT_RECALL_DISTANCE_THRESHOLDS`。
背景の記憶チャンネルは各エピソードに **発生時刻（`occurredAt`）を `[N分前/N日前]` で前置き**する（知覚チャンネルの時間感覚と同じ思想）。記憶内の相対時刻語（「明日」「さっき」）が"いつ基準か"を分からせ、**古い記憶を今の事実として喋る**のを防ぐ（`RecalledEpisode.occurredAt` を `EpisodeRecallHit.timestamp` から `distance.ts → llm-present.ts → turn-context.appendRecalledEpisodes` で通す。`formatRelativeTime` 再利用）。

## 設定

| ファイル | 内容 |
|----------|------|
| `config/settings.json` | モデル名・Ollama ホスト・記憶件数・トークン予算・`stateConfig`・`roles`・`ollamaMaxConcurrency`（LLM 同時実行上限＝サーバ `OLLAMA_NUM_PARALLEL` と揃える） |
| `config/mcp.json` | MCP サーバ定義・`expressDryRun` |
| `config/users.yaml` | 話者 ID → 表示名＋任意の `note`（関係性の一文）。note は言語野の「## 相手について」に注入され、誰と話すかで反応が変わる。recall は話者一致エピソードを重み付け（`SPEAKER_MATCH_BOOST`） |
| `persona/character.md` | キャラクター・口調・一人称 |
| `data/semantic-seed.json` | 夢のタネ（内省風断片） |

環境変数: `OLLAMA_HOST`（settings より優先）, `OLLAMA_THINK`（`roles[*].think` より低優先）, `EXPRESS_DRY_RUN`, `TAVILY_API_KEY`（web 検索＝研究 actor 用。`.env` に置く）。

### embed（記憶想起）— ⚠️ embedModel を変えたら必ず再 index ＋ 全テーブル再 embed

想起の質は `embedModel`（`config/settings.json`）で決まる。既定は **`ruri-v3`**（日本語特化・768 次元）。

- **embedModel を変更したら、必ず `npm run reindex`（memo_index 再生成）＋ `scripts/reembed-tables.mts`（episodes/semantic の vector 再計算）を回す。** 書き込み時と想起時で埋め込み（モデル＋**タスク接頭辞**）が揃っている前提でベクトルが整合するため。揃わないと recall が静かに劣化する。
- タスク接頭辞の単一情報源は `src/llm/embed-prefix.ts`（ruri は**非対称**＝query `検索クエリ: ` / document `検索文書: `。bge-m3 等は不要）。stores は write→`embedDocument` / recall→`embedQuery`。
- `recallDistance` 閾値（full/summarize/omit）は**モデルの距離分布に依存**する（ruri 実測で 0.30/0.40/0.48）。モデルを変えたら距離分布を測り直して調整する。
- モデル選定は当て推量でなく **`npm run eval:retrieval`**（自前 gold で Recall@k・MRR を横並び比較。`--corpus episode` でエピソード想起も。経緯は `docs/research/embedding-locate-eval-2026-06-17.md`）。

研究の web 検索は **Tavily API**（`scripts/mcp-research.mjs`、Docker 不要・`browse_url` は素の fetch）。旧 searxng/Docker は撤去済み（`docker-compose.yml`・`config/searxng/`・`searxng:*` スクリプトは 2026-06-15 に削除）。`mcp-research.mjs` は `.env` から `TAVILY_API_KEY` を自前読み込みする。

ランタイム: TypeScript / Node 20+ / npm / Vitest。LLM は Ollama（`LlmClient` アダプタで差し替え可、`src/llm/`）。

## やってはいけないこと（DECISIONS.md より）

- キーワードマッチでの直行ルーティング
- ロールごとに想起・会話ログの入れ方を変えること
- **判断を要するアクター**の起動をキーワード/ヒューリスティックで代替・スキップすること（判断系は必ず LLM。起動が客観条件で決まるアクター＝recall=常時・視覚=画像の有無・distill=静穏idle は機械ゲート可・ARCH-NEXT §1.6）
- メモ（`data/notes/`）本文を LLM で**要約**すること（劣化するから）。構造保存的な op 編集（厳密置換・見出し差し替え）は read-before-edit ＋厳密一致確認をコードで強制した上でのみ可
- メモ書き込み成功時に `episodes` へ直接追記すること（`memo_index` へ書く）
- 理由のない暗黙トリム（preview・verbose の truncate は別）
- フィルタ・コンテキスト縮小を理由に元データ（LanceDB・state.json）を削除・変更すること

## テスト方針

テストは SPEC の MUST 節を根拠に書く（TDD）。LLM 統合テストは持たず、`src/llm/fake.ts` / `src/mcp/fake.ts` のフェイクを使う。テストは `tests/*.test.ts`。
