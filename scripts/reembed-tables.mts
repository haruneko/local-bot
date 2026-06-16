// 使い捨て: embedModel 切替に伴い episodes / semantic の vector を新モデルで再計算する。
// 768→768 で schema 互換なので mergeInsert で vector のみ更新（他列は読み戻して保持）。
// memo_index は `npm run reindex` で notes から再生成するので対象外。
// 事前に data/lancedb をバックアップ済みであること。
import * as lancedb from "@lancedb/lancedb";
import { lancedbDir } from "../src/config/paths.js";
import { loadSettings } from "../src/config/settings.js";
import { OllamaEmbedClient } from "../src/llm/ollama.js";
import { embedPrefixFor } from "../src/llm/embed-prefix.js";

const settings = await loadSettings();
const host = process.env.OLLAMA_HOST ?? settings.ollamaHost;
const model = settings.embedModel;
const embedder = new OllamaEmbedClient(host, model, embedPrefixFor(model));
console.error(`re-embed with: ${model}  prefix=${JSON.stringify(embedPrefixFor(model))}`);

const conn = await lancedb.connect(lancedbDir());

async function reembed(tableName: string): Promise<void> {
  const table = await conn.openTable(tableName);
  const rows = (await table.query().toArray()) as Record<string, unknown>[];
  console.error(`\n[${tableName}] ${rows.length} 行を再embed…`);
  const updated: Record<string, unknown>[] = [];
  let i = 0;
  for (const r of rows) {
    const body = String(r.body ?? "");
    // synthetic 列を除去（_distance/_rowid 等）して vector だけ差し替え
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) if (!k.startsWith("_")) clean[k] = v;
    clean.vector = body.trim() ? Array.from(await embedder.embedDocument(body)) : Array.from(r.vector as number[]);
    updated.push(clean);
    if (++i % 100 === 0) console.error(`  ${i}/${rows.length}`);
  }
  await table
    .mergeInsert("id")
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(updated);
  console.error(`  [${tableName}] 完了`);
}

await reembed("semantic"); // 小さい方をカナリアに先行
await reembed("episodes");
console.error("\n全テーブル再embed完了");
