// 使い捨て検証: 本採用した ruri の episode 想起を「graded relevance（qwen 判定）」で評価する。
// アンカー一致(下限)でなく、上位ヒットが実際に関連かを LLM-judge で見て precision@k / nDCG@k を出す。
// ライブ ruri ストア(再embed済み)の recall を使うので速い。判定だけ qwen。
import { readFile } from "node:fs/promises";
import { lancedbDir } from "../src/config/paths.js";
import { loadSettings } from "../src/config/settings.js";
import { OllamaEmbedClient } from "../src/llm/ollama.js";
import { embedPrefixFor } from "../src/llm/embed-prefix.js";
import { LanceEpisodeStore } from "../src/memory/lancedb.js";

const N = Number(process.env.N ?? 10); // 判定コストを抑えるため既定10クエリ
const K = 5;
const s = await loadSettings();
const host = process.env.OLLAMA_HOST ?? s.ollamaHost;
const emb = new OllamaEmbedClient(host, s.embedModel, embedPrefixFor(s.embedModel));
const store = await LanceEpisodeStore.open(lancedbDir(), emb);
const chatModel = (s as any).chatModel ?? "qwen3.6:35b-a3b";

const gold = JSON.parse(await readFile("eval/episode-recall.gold.draft.json", "utf8"));
const cases = gold.cases.slice(0, N);

async function judge(query: string, memory: string): Promise<boolean> {
  const res = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: chatModel,
      stream: false,
      options: { temperature: 0 },
      format: { type: "object", properties: { relevant: { type: "boolean" } }, required: ["relevant"] },
      messages: [
        { role: "system", content: "検索評価の判定者。クエリにその記憶が関連するかを厳しめに判定し JSON {\"relevant\":true/false} だけ返す。" },
        { role: "user", content: `クエリ:\n${query}\n\n記憶:\n${memory}\n\nこの記憶はクエリに関連する？` },
      ],
    }),
  });
  if (!res.ok) return false;
  const j = (await res.json()) as any;
  try { return !!JSON.parse(j.message.content).relevant; } catch { return false; }
}

function dcg(rels: number[]): number {
  return rels.reduce((acc, r, i) => acc + r / Math.log2(i + 2), 0);
}

let sumP = 0, sumNdcg = 0, n = 0;
for (const c of cases) {
  const hits = await store.recall(c.query, K);
  const rels: number[] = [];
  for (const h of hits) rels.push((await judge(c.query, String(h.body))) ? 1 : 0);
  const p = rels.reduce((a, b) => a + b, 0) / Math.max(1, rels.length);
  const ideal = [...rels].sort((a, b) => b - a);
  const ndcg = dcg(ideal) > 0 ? dcg(rels) / dcg(ideal) : (rels.some((r) => r) ? 1 : 0);
  sumP += p; sumNdcg += ndcg; n++;
  console.error(`[${n}/${cases.length}] P@${K}=${p.toFixed(2)} nDCG@${K}=${ndcg.toFixed(2)}  rels=[${rels.join("")}]  q=${c.query.slice(0, 30)}`);
}
console.error(`\n=== ruri episode 想起 graded（${n}クエリ・top${K}・qwen判定）===`);
console.error(`平均 precision@${K} = ${(sumP / n).toFixed(3)}`);
console.error(`平均 nDCG@${K}      = ${(sumNdcg / n).toFixed(3)}`);
