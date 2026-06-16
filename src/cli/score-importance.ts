import { loadSettings, resolveOllamaThink } from "../config/settings.js";
import { lancedbDir } from "../config/paths.js";
import { OllamaEmbedClient, OllamaLlmClient } from "../llm/ollama.js";
import { LanceEpisodeStore } from "../memory/lancedb.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { tryParseJsonWithSchema } from "../action/parse-json.js";

const IMPORTANCE_SYSTEM = `エピソード記憶を読み、記憶としての残りやすさ（相手を気にかける存在として、心に残るほど高い）を 1〜10 の整数で採点してください。
出力は JSON オブジェクト1つだけ: {"importance": 数値}

採点基準:
10〜8: 相手の気持ち・状態がにじんだ／相手のことが新しく分かった（好み・予定・約束・困りごと）／頼まれた・相談された／関係の機微、または新しい発見・自分の判断に影響する出来事
7〜5: 普通の会話・いくらか有意義な出来事
4〜2: 相槌・定型・前のターンとほぼ同じ内容の繰り返し・特に変化のない出来事
1: 完全な繰り返し・情報なし`;

const importanceSchema = z.object({ importance: z.number().int().min(1).max(10) });
const importanceJsonSchema = zodToJsonSchema(importanceSchema, {
  name: "ImportanceOutput",
  $refStrategy: "none",
}) as Record<string, unknown>;

const isDryRun = process.argv.includes("--dry-run");
const isVerbose = process.argv.includes("-v") || process.argv.includes("--verbose");

async function main(): Promise<void> {
  const settings = await loadSettings();
  const host = process.env.OLLAMA_HOST ?? settings.ollamaHost;
  const think = resolveOllamaThink(settings);

  const llm = new OllamaLlmClient({ host, model: settings.chatModel, think, numCtx: settings.ollamaNumCtx });
  const embedder = new OllamaEmbedClient(host, settings.embedModel);
  const dbPath = lancedbDir();
  const store = await LanceEpisodeStore.open(dbPath, embedder);

  const all = await store.listSince();
  const targets = all.filter((r) => r.metadata.importance === undefined || r.metadata.importance === 5);

  console.error(`score-importance: 対象 ${targets.length} 件${isDryRun ? "（dry-run）" : ""}`);

  let scored = 0;
  let skipped = 0;

  for (const record of targets) {
    if (!record.body.trim()) { skipped++; continue; }

    const raw = await llm.chat(
      [
        { role: "system", content: IMPORTANCE_SYSTEM },
        { role: "user", content: record.body },
      ],
      { format: importanceJsonSchema, temperature: 0 },
    );
    const parsed = tryParseJsonWithSchema(raw, importanceSchema);
    if (!parsed.ok) { skipped++; continue; }

    const importance = parsed.value.importance;
    if (isVerbose) {
      console.error(`  [${importance}] ${record.body.slice(0, 60).replace(/\n/g, " ")}…`);
    }

    if (!isDryRun) {
      await store.updateImportance(record.metadata.turnId, importance);
    }
    scored++;
    if (scored % 20 === 0) {
      console.error(`  … ${scored} / ${targets.length} 完了`);
    }
  }

  console.error(`完了: ${scored} 件採点, ${skipped} 件スキップ${isDryRun ? "（dry-run・書き込みなし）" : ""}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
