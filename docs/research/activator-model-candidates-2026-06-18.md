# activator（actor 起動判定）向け軽量モデル候補 2026-06-18

actor pool の `activate()` 用に、**no-reasoning（素の instruct）で二値分類＋短い JSON 出力が固い軽量モデル**を Web 調査でランキングした。

## 用途の整理（評価軸）

activator の仕事は actor 1 個ごとの判断:

```json
{"active": true, "intent": "瑠璃の宝石の読書メモのフォーマット確認", "op": "recall"}
```

- 多段推論は不要。**二値分類＋短い文字列＋enum 1 個**。Ollama の `format`（JSON schema）で grammar 拘束する前提。
- 8 並列で回す（`ollamaMaxConcurrency`／`OLLAMA_NUM_PARALLEL`）ので **~1B〜9B か small-active MoE** が現実圏。
- 評価軸: ①no-reasoning 時の指示追従/分類の強さ ②JSON・format 遵守の固さ ③日本語 ④速度・フットプリント ⑤Ollama で pull できるか。

### 前提となる裏づけ: routing/分類に thinking は要らない

- 「100B 未満のモデルでは CoT は性能を上げず、むしろ流暢だが非論理的な思考連鎖を吐いて落とすことがある」（Wei et al. の CoT 論文の既知の限界。複数二次資料が引用）。**小型機ほど thinking はノイズになりやすい**＝この用途の方向性と一致。
- 「reasoning が text classification を本当に改善するか」を問う 2026 のベンチ（TextReasoningBench）や「CoT が人間を悪くするタスクでは CoT がモデルも悪化させる」研究（Mind Your Step）が、**分類/単純タスクで CoT 非優位**を示している。
- LLM routing を「二値分類タスクの集合に還元できる」とする MIT futuretech の routing 研究、および 2026 の routing 実務記事群が、**分類/ルーティングは安価な instruct 段で十分**という業界コンセンサスを裏づける。

つまり依頼者の所感（「e4b は thinking 系で no-reasoning だと物足りない」）は正しく、**狙うべきは『そもそも thinking を前提にしていない純 instruct で分類・指示追従が強い小型機』**。

---

## ランキング表

| # | モデル | 規模 (active) | thinking | no-reasoning の強さ | JSON/format | 日本語 | Ollama タグ | ライセンス | 用途適性 |
|---|--------|------|----------|------|------|------|------|------|------|
| 1 | **Qwen3-4B-Instruct-2507** | 4B dense | **無**（instruct 専用・`<think>` を出さない） | ◎ IFEval **83.4** / BFCL-v3 61.9 | ◎ schema 標準化が得意・tool calling 強 | ◎ 201 言語・日中韓に厚い | `qwen3:4b-instruct-2507`（`qwen3:4b` 系も） | Apache-2.0 | **最有力**。非推論専用で分類/指示追従が小型最強クラス |
| 2 | **Qwen3-1.7B**（非thinking運用） | 1.7B dense | 有（切替式・unthinking 可） | ○ 非thinking で agent/tool 可・2.5-3B 超え | ○ Qwen 系の format 信頼性 | ○ 多言語 | `qwen3:1.7b` | Apache-2.0 | **8並列で一番軽い**現実解。thinking は明示オフ運用 |
| 3 | **Granite 4 micro / micro-h (3B)** | 3B dense | 無（instruct） | ○ IF・tool-calling 改善を明記 | ◎ JSON 出力を設計目標に明記・enterprise tool use 志向 | ○ 日本語を公式サポート言語に明記 | `granite4:3b` / `granite4:micro` / `granite4:3b-h` | Apache-2.0 | format 厳格さ重視ならアリ。日本語の手触りは要実測 |
| 4 | **Ministral-3 3B** | 3B dense | 無（instruct） | ○ native function calling・structured output | ◎ clean JSON・tool-use 設計が明示的 | △〜○ 欧州語強め・日本語は要実測 | （HF GGUF あり・Ollama 取り込みは要確認） | Mistral 系ライセンス（要確認） | tool 選択は強いが日本語が読めるか実測必須 |
| 5 | **Qwen3-0.6B**（非thinking） | 0.6B dense | 有（切替） | △ 極小・単純二値なら可 | ○ Qwen format | △ 小さいぶん日本語は不安定 | `qwen3:0.6b` | Apache-2.0 | 究極の軽量・固定 schema で grammar 拘束する前提なら検討 |
| 6 | **Gemma 3 4B (it)** | 4B dense | 無（it） | ○ 一般指示は良い | △ **tool 呼び/JSON が Llama/Mistral より弱いと複数評** | ◎ 日本語強い | `gemma3:4b` | Gemma ライセンス | 日本語は◎だが**この用途の弱点（tool/JSON）に直撃**。順位を下げた |
| 7 | **Llama 3.2 3B Instruct** | 3B dense | 無 | ○ instruction-following 安定 | ○ prompt 方式 tool calling（特殊トークン無） | △ 日本語は弱め（→ Swallow/ELYZA 派生で補完可） | `llama3.2:3b` | Llama Community | 安定だが日本語が弱点。日本語特化派生の母体としては有力 |
| 8 | **Phi-4-mini 3.8B** | 3.8B dense | 無 | ○ IF・function calling を後訓練で強化 | ○ function-calling format サポート | △ 日本語はサポート言語だが厚みは限定的 | `phi4-mini:3.8b` | MIT | バランス型。日本語の手触りが Qwen/Gemma に劣りがち |
| – | Qwen3.5 Small (0.8B/2B/4B/9B) | dense | **無が既定**（reasoning off default） | ◎（4B/9B は次世代で有力） | ○（tool 改善あり） | ◎ 201 言語 | **現状 Ollama 未対応**（GGUF が mmproj 分離で動かず・llama.cpp 系で要運用） | Apache-2.0 系 | **本命候補だが今は Ollama で pull 不可**。対応待ち |
| – | Gemma 4 e2b/e4b | small | **thinking 系** | △ no-reasoning だと物足りない（実機所感どおり） | – | ◎ | `gemma4:e2b` 等 | Gemma | 出発点の不満そのもの。除外 |
| – | 日本語特化小型（Sarashina2.2-3B / TinySwallow-1.5B / ELYZA-JP-8B / Llama-3.x-Swallow） | 1.5B〜8B | 無 | 日本語の自然さは随一 | **function-calling/JSON の明示サポートが乏しい**（要自前検証） | ◎◎ | 一部のみ Ollama 化・多くは HF GGUF を自前 import | 各派生ライセンス | 日本語が崩れて困る場合の保険。activator 用途では JSON 遵守を実測しないと採用不可 |

---

## 各候補の短評

### 1. Qwen3-4B-Instruct-2507 ← 一押し
- **非thinking 専用版**（`enable_thinking` 指定すら不要・`<think>` を一切出さない）。まさに「reasoning を使わない素の instruct」そのもの。
- IFEval 83.4 は 4B クラスでは非常に高く、**指示追従＝format 遵守の固さに直結**。BFCL-v3 61.9 で tool/関数選択も強い。
- distil labs の小型機ベンチで**ファインチューン後平均ランク 1 位（2.25）**＝「小型で分類タスクの土台に選ぶなら Qwen3 系」が定量裏づけ。
- 日本語も Qwen 系の強み。8 並列でも 4B dense は現実的フットプリント。

### 2. Qwen3-1.7B
- 8 並列スループットを最優先するならこれ。Qwen3 技術報告で**非thinking モードでも agent/tool 連携可**、半数以上のベンチで Qwen2.5-3B を上回ると明記。
- thinking 切替式なので **明示的に thinking オフで運用**（`/no_think` 相当 or テンプレ設定）。1.7B でも grammar 拘束（`format`）を併用すれば二値＋enum は十分実用。

### 3. Granite 4 micro (3B)
- IBM が**JSON 出力・tool use を設計目標に**据えた enterprise 系。日本語を公式サポート言語に列挙。Apache-2.0 でライセンスも素直。
- hybrid mamba-2（`-h`）は長文/低メモリに効く。**format 遵守の堅さを最優先**するなら有力。日本語の自然さは Qwen/Gemma に一歩譲る可能性、実測推奨。

### 4. Ministral-3 3B
- native function calling＋clean JSON を売りにした小型機で、**tool 選択の素質は高い**。ただし日本語の厚みが Qwen/Gemma ほど確証なし。Ollama 取り込み状況も要確認（HF GGUF は存在）。

### 5〜8（条件付き）
- **Qwen3-0.6B**: 極軽量。固定 schema を `format` で拘束する activator なら、単純 actor の二値判定くらいは担える可能性。日本語は不安定。
- **Gemma 3 4B**: 日本語は◎だが「tool 呼び/JSON が Llama・Mistral より弱い」という複数評が、まさに activator の急所に当たる。会話モデルとしては良いが判定係には不向き寄り。
- **Llama 3.2 3B**: 安定指示追従だが日本語が弱い。Swallow/ELYZA 等の**日本語特化派生の母体**として価値。
- **Phi-4-mini 3.8B**: function calling を後訓練で強化したバランス型。日本語の手触りが要確認。

### 採用を見送る/様子見
- **Qwen3.5 Small（0.8B/2B/4B/9B）**: **reasoning オフが既定**で思想的に理想だが、**現状 Ollama で pull 不可**（GGUF が mmproj 分離で未対応）。Ollama 対応が来たら 4B/9B は本命に昇格しうる。要ウォッチ。
- **Gemma 4 e2b/e4b**: thinking 系。no-reasoning だと物足りないという出発点の不満そのもの。除外。
- **日本語特化小型（Sarashina/TinySwallow/ELYZA/Swallow）**: 日本語の自然さは随一だが、**function-calling/JSON の明示サポートが弱く**、activator の JSON 遵守を自前検証しないと採用できない。会話本体（language-agent）側の候補としては別途有望。

---

## 総合おすすめ Top3（8並列・no-reasoning・JSON固い・日本語OK）

1. **Qwen3-4B-Instruct-2507**（`qwen3:4b-instruct-2507`）
   - **非thinking 専用**でIFEval 83.4／BFCL 61.9／日本語◎／小型分類ベンチ 1 位。「no-reasoning で分類・指示追従が強い純 instruct」という要件に最も真っ直ぐ当てはまる。Apache-2.0。**まず本命として実機比較すべき。**

2. **Qwen3-1.7B**（`qwen3:1.7b`、thinking 明示オフ運用）
   - **8 並列スループット最優先の現実解**。非thinking で tool/agent 可・format 信頼性も Qwen 系。grammar 拘束併用で二値＋enum は十分。4B が重ければこちら。

3. **Granite 4 micro / micro-h 3B**（`granite4:3b` / `granite4:micro-h`）
   - **JSON・tool use を設計目標に据えた**堅さ枠。Apache-2.0・日本語公式サポート。Qwen 系で format が崩れる/裸文字列を吐く現象（既知の小型 Qwen の弱点）が再発したときの**保険・対抗馬**として実測する価値が高い。

### 一押しの理由（一言）
**Qwen3-4B-Instruct-2507 が頭一つ抜けている。** 「thinking を切ると落ちる」のではなく**最初から非thinking 専用**で、その状態で IFEval 83.4 という小型最強クラスの指示追従＝format 遵守を持ち、tool 選択ベンチも高く、日本語も通る。`format`（JSON schema）で grammar 拘束する activator 用途に、要件 5 軸すべてを最も素直に満たす。8 並列が重ければ **Qwen3-1.7B** に落とし、format が崩れたら **Granite 4 micro** を当てる、の二段構えが実戦的。

> 注: 小型 Qwen が稀に `format` を無視して裸文字列を吐く既知問題（プロジェクトメモにも記録あり）は、`qwen3:*` 系でも完全には消えない可能性がある。**Ollama の `format` で JSON schema を必ず渡し、パース失敗時のリトライ/フォールバックを実装する前提**で採用すること。format 遵守の固さは最終的に実機（自前の数十ケース）で測るのが確実。

---

## Sources

- [Qwen/Qwen3-4B-Instruct-2507 · Hugging Face](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507)
- [Qwen/Qwen3-1.7B · Hugging Face](https://huggingface.co/Qwen/Qwen3-1.7B)
- [Qwen3 Technical Report (arXiv 2505.09388)](https://arxiv.org/pdf/2505.09388)
- [Qwen3: Think Deeper, Act Faster | Qwen Blog](https://qwenlm.github.io/blog/qwen3/)
- [Qwen3.5 - How to Run Locally | Unsloth Documentation](https://unsloth.ai/docs/models/qwen3.5)
- [ollama library: qwen3](https://ollama.com/library/qwen3)
- [ollama library: granite4](https://ollama.com/library/granite4)
- [ollama library: phi4-mini:3.8b](https://ollama.com/library/phi4-mini:3.8b)
- [microsoft/Phi-4-mini-instruct · Hugging Face](https://huggingface.co/microsoft/Phi-4-mini-instruct)
- [mistralai/Ministral-3-8B-Instruct-2512 · Hugging Face](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512)
- [Ministral 3 3B Local Setup Guide with MCP Tool Calling (DEV)](https://dev.to/composiodev/ministral-3-3b-local-setup-guide-with-mcp-tool-calling-icm)
- [We Benchmarked 12 Small Language Models Across 8 Tasks — distil labs](https://www.distillabs.ai/blog/we-benchmarked-12-small-language-models-across-8-tasks-to-find-the-best-base-model-for-fine-tuning/)
- [Gemma 4 vs Qwen 3.5: Open-Weight Comparison — MindStudio](https://www.mindstudio.ai/blog/gemma-4-vs-qwen-3-5-open-weight-comparison)
- [Gemma 4 vs Llama 4 vs Qwen 3.5: 2026 Comparison — Lushbinary](https://lushbinary.com/blog/gemma-4-vs-llama-4-vs-qwen-3-5-open-weight-model-comparison/)
- [Best Ollama Models in 2026 — Serverman](https://www.serverman.co.uk/ai/ollama/best-ollama-models-2026/)
- [Best Small Language Models 2026: 12 SLMs for 8GB RAM — Local AI Master](https://localaimaster.com/blog/small-language-models-guide-2026)
- [Large Language Model Routing with Benchmark Datasets — MIT FutureTech](https://futuretech.mit.edu/publication/large-language-model-routing-benchmark-datasets)
- [LLM Model Routing in 2026: Cost-Quality Optimization — Digital Applied](https://www.digitalapplied.com/blog/llm-model-routing-2026-cost-quality-optimization-engineering-guide)
- [TextReasoningBench: Does Reasoning Really Improve Text Classification? (arXiv)](https://arxiv.org/pdf/2603.19558)
- [Mind Your Step (by Step): Chain-of-Thought can Reduce Performance (arXiv 2410.21333)](https://arxiv.org/html/2410.21333v1)
- [Chain-of-Thought Prompting Elicits Reasoning in LLMs — Wei et al. (arXiv 2201.11903)](https://arxiv.org/pdf/2201.11903)
- [awesome-japanese-llm](https://awesome.ecosyste.ms/lists/llm-jp/awesome-japanese-llm)
- [Llama 3 Swallow — Swallow LLM](https://swallow-llm.github.io/llama3-swallow.en.html)
- [elyza/Llama-3-ELYZA-JP-8B · Hugging Face](https://huggingface.co/elyza/Llama-3-ELYZA-JP-8B)
