import { loadSettings, resolveActionModel } from "../config/settings.js";
import { lancedbDir } from "../config/paths.js";
import { OllamaEmbedClient, OllamaLlmClient } from "../llm/ollama.js";
import { embedPrefixFor } from "../llm/embed-prefix.js";
import { LanceEpisodeStore } from "../memory/lancedb.js";
import { LanceXmodalStore, type XmodalStore } from "../memory/xmodal-lancedb.js";
import { createTurnContext } from "../context/turn-context.js";
import { runForget } from "../roles/forget.js";

/**
 * プライバシー用 out-of-band の本気削除（DECISIONS §記憶 faculty「runForget 温存」の口）。
 * 通常ターンの忘却は減衰であって意志の op を持たない。これは人手で明示的に消すための別経路。
 *
 *   npm run forget -- "コーヒーの好みの話"   # 候補から1件選んで soft delete（横断行も一緒に消す）
 *   npm run forget -- --list "コーヒー"      # 候補一覧だけ表示（消さない）
 */

function usage(): never {
  console.error('usage: npm run forget -- [--list] "<何を忘れるか>"');
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes("--list");
  const intent = argv.filter((a) => a !== "--list").join(" ").trim();
  if (!intent) usage();

  const settings = await loadSettings();
  const host = process.env.OLLAMA_HOST?.trim() || settings.ollamaHost;
  const embedder = new OllamaEmbedClient(
    host,
    settings.embedModel,
    embedPrefixFor(settings.embedModel),
  );
  const episodes = await LanceEpisodeStore.open(lancedbDir(), embedder);

  if (listOnly) {
    const hits = await episodes.recall(intent, settings.episodeRecallTopK);
    if (hits.length === 0) {
      console.error("該当する記憶は見つからなかった");
      return;
    }
    for (const h of hits) {
      const body = h.body.replace(/\s+/g, " ").slice(0, 120);
      console.log(`turnId=${h.turnId} distance=${h.distance.toFixed(3)}\n  ${body}`);
    }
    return;
  }

  let xmodal: XmodalStore | undefined;
  if (settings.crossmodal?.enabled) {
    xmodal = await LanceXmodalStore.open(lancedbDir());
  }

  const llm = new OllamaLlmClient({
    host,
    model: resolveActionModel(settings),
    think: false,
  });
  const ctx = createTurnContext({
    turnId: `forget-cli-${Date.now()}`,
    state: "静穏",
    trigger: { type: "user_message", content: intent, speakerId: "cli" },
    dialogue: { resolveUserDisplayName: () => "CLI" },
    recentTurns: [],
    recalledEpisodes: [],
  });

  const outcome = await runForget(llm, {
    ctx,
    action: { kind: "memory", intent },
    episodes,
    episodeRecallTopK: settings.episodeRecallTopK,
    xmodal,
  });

  if (!outcome.attempted) {
    console.error("実行されなかった");
    process.exit(1);
  }
  console.log(outcome.summary);
  if (outcome.status !== "succeeded") process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
