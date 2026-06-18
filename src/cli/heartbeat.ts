import { createApp } from "../app/bootstrap.js";
import { parseArgs } from "./args.js";
import { printTurnSummary } from "./output.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.error("heartbeat: 接続中… (Ollama / LanceDB)");
  // 口の効果器: 独り言＋成果物を即出力（出力路を効果器に揃える）。
  const outputChannel = {
    say: (speech: string | null, artifacts: string[]) => {
      if (speech) console.log(speech);
      for (const artifact of artifacts) console.log(`\n${artifact}`);
    },
  };
  const app = await createApp({
    speakerId: args.speakerId,
    memory: args.memory,
    logLevel: args.logLevel ?? "info",
    outputChannel,
  });
  const { orchestrator, verbose } = app;

  const result = await orchestrator.run({ type: "heartbeat" });
  if (verbose.enabled) {
    console.error(
      `[verbose] heartbeat: speech=${!!result.speech} episodeSaved=${result.episodeSaved}`,
    );
  }
  printTurnSummary(result, verbose);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
