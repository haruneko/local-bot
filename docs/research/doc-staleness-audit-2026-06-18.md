# ドキュメント陳腐化監査（2026-06-18）

CLAUDE.md と docs/*.md（CONCEPT/SPEC/DECISIONS/ACTION-DESIGN/ARCH-NEXT/MEMO-TREE/ROADMAP）の記述を、
実際の `src/`・`config/settings.json`・`package.json` と一文ずつ突き合わせ、食い違いを洗い出した。
**読み取り専用監査。コード・config・docs は一切変更していない。** `docs/archive/` は対象外。

各指摘は「docs の該当箇所」「実際のコード/設定」「どう食い違うか」「推奨修正」「直すべき側」の形でまとめる。
最後に重大度で分類する。

---

## 重大度: 実害大（誤った識別子・誤解を生む記述）

### 1. `runRecallLoop` という存在しない関数を docs が参照している（既知・確認済み）

- **docs**:
  - CLAUDE.md:42 「run が `runRecallLoop`/`runForget` に振る」
  - docs/DECISIONS.md:500 「run が `runRecallLoop`/`runForget` に振る」
  - docs/DECISIONS.md:504 「run 関数 `runRecallLoop`/`runForget` は温存」
  - docs/ROADMAP.md:177 「現在の多段想起（`runRecallLoop`）は『同一ターン内の多段』」
- **コード**: `src/actors/memory.ts:6` は `import { runRecall } from "../roles/recall.js"` のみ。
  `src/roles/recall.ts:9` の `runRecall` が実体。`grep -rn "runRecallLoop" src/` はゼロ件。
- **食い違い**: 関数名が違う（`runRecallLoop` → `runRecall`）。さらに「多段想起ループ」自体が無い。
  `runRecall` は LanceDB ベクトル検索のヒット上位を **機械的にそのまま top-2 提示**するだけ
  （`recall.ts:37-41` のコメント「LLM 要約しない＝想起の二度手間・劣化・遅延を避ける」）。
  ROADMAP:177 の「同一ターン内の多段」は廃止済みの旧仕様。
- **推奨修正（一文）**: docs の `runRecallLoop` を `runRecall` に置換し、「想起は機械的 top-2 提示（多段ループは廃止）」へ書き換える。
- **直す側**: docs（実装が正・想起の機械提示化が新しい）。

### 2. SPEC.md の `ActionFacts` 型が古い（`synthesize` kind 欠落・`research` の `summary` 欠落）

- **docs**: docs/SPEC.md:109-117 の `ActionFacts` 定義。`research` は `{ tool, title, body }`、
  `synthesize` kind が存在しない（`plan` までで終わっている）。
- **コード**: `src/action/facts.ts:1-10`:
  - `research` は `{ kind:"research"; tool; title; summary; body }`（**`summary` フィールドあり**）
  - `{ kind:"synthesize"; filename; body }` が**存在する**
- **食い違い**: SPEC の型が実装に2点遅れている。なお ACTION-DESIGN.md:88-99 の同じ型定義は
  `synthesize` を含み正しい（ただし `research` の `summary` は ACTION-DESIGN でも欠落）。
- **推奨修正（一文）**: SPEC.md §5.3 と ACTION-DESIGN.md の `ActionFacts` を `facts.ts` の最新定義に揃える
  （`synthesize` 追加・`research` に `summary` 追加）。
- **直す側**: docs（実装が正）。

### 3. SPEC.md「8B でチャンネル要約」— 8B モデルも「チャンネル要約」も実態と違う

- **docs**: docs/SPEC.md:200「トークン超過時: 8B でチャンネル要約（失敗時のみ機械切り詰め）」。
- **コード**: `src/context/preprocess.ts:9-59` `fitTurnContext`。
  - Step1=作業記憶の古いターンを機械的に削る、Step2=**想起エピソードだけ**を LLM 要約（`summarizeChannel`, line 32-36）、
    最終手段=`truncateTurnContext`（機械切り詰め）。
  - 要約に使う `llm` は呼び出し元から渡る**メインのチャットクライアント**で、専用 8B モデルではない。
    実 `chatModel` は `config/settings.json:12` の `qwen3.6:35b-a3b`（≒30B）。
- **食い違い**: (a) 「8B」というモデルは存在しない（30B のチャットモデルを使う）、(b) 「チャンネル要約」ではなく
  「想起エピソードのみの要約」、(c) 先に作業記憶のターン削りが入る点が抜けている。
- **推奨修正（一文）**: 「トークン超過時はまず作業記憶の古いターンを機械削り、足りなければ想起エピソードを chatModel で要約（最終手段は機械切り詰め）」に書き換える。
- **直す側**: docs（実装が正）。MEMO-TREE.md:8 の「30B のコンテキスト」は正しい（chatModel と整合）。

### 4. CLAUDE.md / SPEC.md の `ollamaMaxConcurrency` 既定値が食い違う（CLAUDE は無記載・SPEC は「既定2」）

- **docs**:
  - docs/SPEC.md:35「既定2・settings で上書き」
  - docs/DECISIONS.md:530「上限は `settings.ollamaMaxConcurrency`（既定 2・保守的）…（現状 4）」
- **コード/設定**:
  - `src/llm/limit.ts:11` `DEFAULT_CONCURRENCY = 2`、`src/app/bootstrap.ts:138`
    `configureLlmConcurrency(settings.ollamaMaxConcurrency ?? 2)` → **コード既定は 2 で正しい**。
  - ただし `config/settings.json:17` は `"ollamaMaxConcurrency": 4` を**明示**しているので、
    実行時の実効値は **4**。
- **食い違い**: docs の「既定2」はコード既定としては正しいが、settings.json が 4 を明示しているため
  実効値（4）と読者が混同しうる。DECISIONS:530 は「（現状 4）」と補足しており最も正確。
  SPEC.md:35 は「既定2」のみで実効値 4 に触れていない。
- **推奨修正（一文）**: SPEC.md:35 に「settings.json で 4 を明示中（実効値 4）」を補い、DECISIONS の記述に揃える。
- **直す側**: docs（補足追記）。コード・設定は整合済み。

---

## 重大度: 軽微（表記ゆれ・列挙漏れ・実害は限定的）

### 5. memo の op 一覧が docs 内で不統一（`replace_line`/`delete_line` の欠落が複数箇所）

- **docs**:
  - 正しい（全 op）: SPEC.md:86、CLAUDE.md:48、MEMO-TREE.md:36（`view/create/append/replace/section_replace/replace_line/delete_line/noop`）
  - 古い（行 op 欠落）: ACTION-DESIGN.md:48「op を1つ（view/create/append/replace/section_replace/noop）」、
    DECISIONS.md:8（改訂履歴）「view/create/append/replace/section_replace」、
    DECISIONS.md:83「create / append / replace / section_replace」
- **コード**: `src/memo/ops.ts:12-19` と `src/prompts/schemas.ts:12-20` は
  `view/create/append/replace/section_replace/replace_line/delete_line/noop` の8種。`roles.ts:105-106` にも行 op あり。
- **食い違い**: ACTION-DESIGN/DECISIONS の一部が行 op（`replace_line`/`delete_line`）を列挙していない。
  実害は小（読者が op の存在を見落とす程度）。DECISIONS:8/83 は時系列の決定記録なので当時の op で正しい面もある。
- **推奨修正（一文）**: ACTION-DESIGN.md:48 の op 列挙に `replace_line`/`delete_line` を追記する（DECISIONS の履歴行は据え置き可）。
- **直す側**: docs（ACTION-DESIGN.md:48 のみ）。

### 6. SPEC.md の `vagueMax` 説明が「想起グラデーション閾値」のまま（提示段から外れている）

- **docs**: docs/SPEC.md:31「`recallDistance.fullMax/summarizeMax/vagueMax` | 想起グラデーション閾値」。
- **コード**: `src/recall/distance.ts:40-52, 166-173`。提示段は `full`/`summarize`/`omit` の2段化済みで、
  `vagueMax` は **presentation の段ではなく relevance 正規化（0 になる距離）の上限**としてのみ使う
  （`distanceToRelevance`）。これは DECISIONS.md:201 と CLAUDE.md:60 が正しく説明済み。
- **食い違い**: SPEC.md の表だけ「vague=グラデーション閾値」という旧解釈のまま。`vague` 段廃止が反映されていない。
- **推奨修正（一文）**: SPEC.md:31 を「`fullMax/summarizeMax` が提示段（超過は omit）、`vagueMax` は relevance 正規化の上限」に直す。
- **直す側**: docs（実装・DECISIONS が正）。

### 7. SPEC.md §9 プリプロセスの想起提示説明が `vague` 廃止前のまま

- **docs**: docs/SPEC.md:198「距離分類（`full`/`summarize`、`summarizeMax` 超は `omit`）」自体は正しい。
  ただし同節は背景想起が LLM 要約（`summarize`）を使う前提で書かれており、明示 recall actor 側（`runRecall`）が
  **機械 top-2 提示**である点はどこにも書かれていない。
- **コード**: 背景想起（preprocess→`presentRecallEpisodes`）は full=そのまま/summarize=LLM 要約（`llm-present.ts`）で
  SPEC と整合。一方 memory actor の明示想起（`recall.ts`）は LLM を使わず機械提示で、性質が違う。
- **食い違い**: 背景想起と明示 recall の提示方式が異なる（前者 LLM 要約あり・後者なし）ことが docs で区別されていない。
  指摘1とも連動。
- **推奨修正（一文）**: SPEC/CLAUDE に「背景想起=full/summarize（summarize は LLM）／明示 recall actor=機械 top-2」の対比を一文足す。
- **直す側**: docs（区別の明確化）。

### 8. CLAUDE.md の距離閾値 0.30/0.40/0.48 は settings と一致（陳腐化なし・記録のため明記）

- **docs**: CLAUDE.md:91「ruri 実測で 0.30/0.40/0.48」、DECISIONS.md:193 同値。
- **設定**: `config/settings.json:6-10` `recallDistance` = `fullMax 0.3 / summarizeMax 0.4 / vagueMax 0.48`。**一致**。
- **注意点**: `src/recall/distance.ts:48-52` の `DEFAULT_RECALL_DISTANCE_THRESHOLDS` は 0.45/0.72/0.85（旧 nomic 系の値）。
  これは settings.json 不在時のフォールバックで、実運用は settings が上書きするため実効値は 0.30/0.40/0.48。
  docs はこの「コード既定 vs settings 実効値」の関係を DECISIONS.md:193 で正しく説明している（陳腐化ではない）。
- **結論**: 陳腐化なし。embedModel（ruri-v3）・768次元・タスク接頭辞の記述（CLAUDE.md:87-91, DECISIONS.md:20）も
  `config/settings.json:13` と `src/llm/embed-prefix.ts` に整合。

### 9. searxng/Docker・remember 廃止の記述は正しく撤去反映済み（陳腐化なし）

- searxng/Docker 撤去（CLAUDE.md:94, ACTION-DESIGN.md:78, DECISIONS.md:389）は Tavily 移行と整合。
  `scripts/mcp-research.mjs` 実在、`docker-compose.yml`/`config/searxng/` は不在。
- `remember` 廃止（SPEC.md:93, ACTION-DESIGN.md:47, CONCEPT.md:102）も `src/actors/` に remember actor 無しで整合
  （`EpisodeSource "remember"` 温存・`ActionFacts kind:"remember"` 温存は意図どおり）。
- **結論**: 陳腐化なし（過去の懸念点はクリア）。

### 10. ROADMAP/ARCH-NEXT に残る "nomic" 表記（読み替え注記で救済済み・要注意）

- **docs**: ARCH-NEXT.md:128-152, ROADMAP.md は本文で "nomic" を多用。
- **救済**: ARCH-NEXT.md:126 と ROADMAP.md:232 に「nomic → ruri-v3 に変更、以下の nomic は ruri-v3 と読み替え」の
  明示注記がある。embedModel は実際 `ruri-v3`（settings.json:13）。
- **食い違い**: 注記で救済されているが、本文の生 "nomic" 表記が多く、注記を見落とすと誤読しうる。実害は中〜小。
- **推奨修正（一文）**: 急がないが、いずれ本文の "nomic" を "ruri-v3" に置換すると注記依存を解消できる。
- **直す側**: docs（任意・低優先）。

---

## コマンド・actor 一覧の突き合わせ（package.json / settings.json）

### 11. `npm run *` コマンド一覧は概ね整合（CLAUDE.md §コマンド）

- **package.json scripts**（実在）: build, dev, start, heartbeat, say, dream, test, test:watch, slack,
  smoke, score-importance, reindex, notes:rm, eval:retrieval。
- **CLAUDE.md §コマンド** は dev/heartbeat/say/dream/test/test:watch/build/smoke/reindex/notes:rm/eval:retrieval を記載。
- **差分（軽微・実害小）**:
  - `npm run slack`（package.json:16 に実在）が CLAUDE.md のコマンド一覧に未記載（restart-slack スキル経由で使う想定か）。
  - `npm run score-importance`（package.json:18 に実在）が CLAUDE.md に未記載。
    SPEC §CLI にも無い。DECISIONS には importance 採点の議論はあるがコマンドの明記は薄い。
- **推奨修正（一文）**: CLAUDE.md のコマンド節に `slack` と `score-importance` を補足する（任意）。
- **直す側**: docs（補足）。
- **注**: CLAUDE.md:16 の `npm run say` 既定話者 `claude_kuro` は `src/cli/say.ts:6` `DEFAULT_SPEAKER = "claude_kuro"` と一致。
  `--memory-only`（args.ts:20, say.ts:9）も整合。

### 12. actor 一覧・stateConfig・モデル設定は整合（陳腐化なし）

- actor 7種（`memory memo webSearch urlBrowse webcam plan synthesize`）は CLAUDE.md:42 / SPEC.md:81-91 /
  ACTION-DESIGN.md:42-53 / CONCEPT.md:102 と `config/settings.json:20-79`・`src/app/bootstrap.ts:253` に一致。
- `webcam` の「未実装」記述（SPEC.md:89, ACTION-DESIGN.md:51）は settings.json:53 `"enabled": false` と整合。
- モデル設定（`chatModel=qwen3.6:35b-a3b` / `actionModel=qwen3-vl:8b-instruct` / `activatorModel=qwen3.6:35b-a3b` /
  `roles.{language,introspection,affect}`）は DECISIONS.md:19,304-308 / CONCEPT.md:181 / SPEC.md:32-41 と
  `config/settings.json:12,117-132` に一致。`activatorModel` の説明（SPEC.md:34）も `settings.ts:218` の
  「未設定は actionModel」ロジックと整合。
- `imageFeedSource`（SPEC.md:36）は settings.json:133 `"data/frames"` と整合。
- **結論**: 陳腐化なし。

---

## まとめ（優先度順）

| # | 指摘 | 重大度 | docs 該当 | 直す側 |
|---|------|--------|-----------|--------|
| 1 | `runRecallLoop` 不在（→`runRecall`・多段ループ廃止） | 実害大 | CLAUDE.md:42, DECISIONS:500/504, ROADMAP:177 | docs |
| 2 | SPEC `ActionFacts` 型が古い（synthesize/summary 欠落） | 実害大 | SPEC:109-117（ACTION-DESIGN:88-99 も summary 欠落） | docs |
| 3 | 「8B でチャンネル要約」が二重に誤り | 実害大 | SPEC:200 | docs |
| 4 | `ollamaMaxConcurrency` 既定2 と実効値4 の混同 | 実害大寄り | SPEC:35 | docs（補足） |
| 5 | memo op 一覧の不統一（行 op 欠落） | 軽微 | ACTION-DESIGN:48 ほか | docs |
| 6 | `vagueMax`=「グラデーション閾値」表記残存 | 軽微 | SPEC:31 | docs |
| 7 | 背景想起 vs 明示 recall の提示方式の区別なし | 軽微 | SPEC:198 ほか | docs |
| 10 | 本文 "nomic" 表記（注記で救済済み） | 軽微 | ARCH-NEXT/ROADMAP 各所 | docs（任意） |
| 11 | コマンド一覧に slack/score-importance 未記載 | 軽微 | CLAUDE.md §コマンド | docs（任意） |

陳腐化なしと確認した項目: 距離閾値 0.30/0.40/0.48（#8）、searxng/Docker・remember 廃止反映（#9）、
actor 一覧・stateConfig・モデル設定・imageFeedSource・say 既定話者（#12）。

**全指摘の修正方向は「docs を実装に合わせる」**（実装側のバグ・退行は本監査では検出していない）。
最優先は #1〜#3（誤った識別子・誤解を生む記述）。変更は本監査では一切行っていない。
