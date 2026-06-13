import path from "node:path";
import { loadSettings } from "../config/settings.js";
import { OllamaEmbedClient } from "../llm/ollama.js";
import { LanceMemoIndexStore } from "../memory/memo-index-lancedb.js";
import { reindexNotes } from "../memo/reindex.js";

/** data/notes/ を memo_index に索引化する（recall 認識の前提整備）。`npm run reindex`。 */
async function main(): Promise<void> {
  const settings = await loadSettings();
  const host = process.env.OLLAMA_HOST ?? settings.ollamaHost;
  const embedder = new OllamaEmbedClient(host, settings.embedModel);
  const dbPath = path.join(process.cwd(), "data", "lancedb");

  console.error("reindex: data/notes/ を memo_index に索引中…");
  const store = await LanceMemoIndexStore.open(dbPath, embedder);
  const { indexed, skipped } = await reindexNotes(store);
  console.error(
    `完了: ${indexed} 件 upsert / ${skipped} 件スキップ（_index.md・空ファイル）`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
