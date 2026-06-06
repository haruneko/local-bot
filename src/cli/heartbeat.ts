import { createApp } from "../app/bootstrap.js";
import { parseArgs } from "./args.js";
import { printTurnSummary } from "./output.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.error("heartbeat: 接続中… (Ollama / LanceDB)");
  const app = await createApp({
    speakerId: args.speakerId,
    memory: args.memory,
    verbose: args.verbose,
  });
  const { orchestrator, verbose } = app;

  const result = await orchestrator.run({ type: "heartbeat" });
  if (verbose.enabled) {
    console.error(
      `[verbose] heartbeat judge: REPLY=${result.judge.REPLY} ACTION=${result.judge.ACTION.kind} episodeSaved=${result.episodeSaved}`,
    );
  }
  printTurnSummary(result, verbose);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
