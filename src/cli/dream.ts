import { createApp } from "../app/bootstrap.js";
import { parseDreamArgs } from "./args.js";
import { runDream } from "../roles/dream.js";
import {
  defaultSemanticSeedPath,
  loadSemanticSeed,
} from "../memory/semantic-seed.js";
import {
  defaultDreamStatePath,
  loadDreamState,
} from "../state/dream-state.js";
import { resolveDreamMinEpisodes } from "../config/settings.js";
import { FakeMcpToolProvider } from "../mcp/fake.js";

async function main(): Promise<void> {
  const args = parseDreamArgs(process.argv.slice(2));
  console.error("dream: 接続中… (Ollama / LanceDB)");
  const app = await createApp({
    speakerId: args.speakerId,
    memory: args.memory,
    logLevel: args.logLevel ?? "quiet",
    mcp: new FakeMcpToolProvider(),
  });

  const seedRequested = args.seedPath !== undefined;
  const seedFile =
    args.seedPath === "" || args.seedPath === undefined
      ? defaultSemanticSeedPath()
      : args.seedPath;
  const seed = seedRequested ? await loadSemanticSeed(seedFile) : [];

  const before = await loadDreamState(defaultDreamStatePath());
  const result = await runDream({
    llm: app.llm,
    episodes: app.episodes,
    semantic: app.semantic,
    minEpisodes: resolveDreamMinEpisodes(app.settings),
    seed,
    applySeed: seedRequested,
    forceSeed: args.forceSeed,
  });

  if (result.ran) {
    const parts: string[] = [];
    if (result.seedProcessed > 0) {
      parts.push(`タネ ${result.seedProcessed} 件`);
    }
    if (result.episodesProcessed > 0) {
      parts.push(`エピソード ${result.episodesProcessed} 件`);
    }
    const source = parts.length > 0 ? parts.join(" + ") : "素材";
    console.log(
      `夢完了: ${source} から ${result.factsUpserted} 件の意味記憶を蒸留しました`,
    );
    if (result.seedAppliedAt) {
      console.log(`seedAppliedAt: ${result.seedAppliedAt}`);
    }
    console.log(`lastDreamAt: ${result.lastDreamAt ?? "（エピソードなし）"}`);
  } else {
    console.log(`夢スキップ: ${result.skippedReason ?? "理由不明"}`);
    console.log(
      `lastDreamAt: ${result.lastDreamAt ?? before.lastDreamAt ?? "（未実行）"}`,
    );
    if (before.seedAppliedAt) {
      console.log(`seedAppliedAt: ${before.seedAppliedAt}（適用済み）`);
    } else if (!seedRequested) {
      console.log(
        "ヒント: 初回は `npm run dream -- --seed` で夢のタネを蒸留できます",
      );
    }
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
