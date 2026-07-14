import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createApp } from "../app/bootstrap.js";
import { parseArgs } from "./args.js";
import { printTurnSummary } from "./output.js";
import { loadSettings, resolveVoiceSettings } from "../config/settings.js";
import { createVoiceOutputChannel } from "../voice/channel.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log("接続中… (Ollama / LanceDB)");

  // 音声チャンネルの判断: --voice フラグ または settings.voice.enabled
  const settings = await loadSettings();
  const voiceCfg = resolveVoiceSettings(settings);
  const useVoice = args.voice === true || voiceCfg.enabled;

  // 口の効果器: 発話＋成果物を即出力（REPL・出力路を効果器に揃える）。
  const outputChannel = useVoice
    ? createVoiceOutputChannel({
        print: (text) => console.log(text),
        printArtifact: (text) => console.log(text),
        voice: { host: voiceCfg.host, speaker: voiceCfg.speaker },
      })
    : {
        say: (speech: string | null, artifacts: string[]) => {
          if (speech) console.log(speech);
          for (const artifact of artifacts) console.log(`\n${artifact}`);
        },
      };

  const app = await createApp({
    speakerId: args.speakerId,
    memory: args.memory,
    logLevel: args.logLevel ?? "quiet",
    outputChannel,
  });
  const { orchestrator, speakerId, verbose } = app;

  const rl = readline.createInterface({ input, output });
  const verboseHint = verbose.enabled
    ? "詳細ログは stderr に出力\n"
    : "";
  console.log(
    `${verboseHint}local-bot (${settings.chatModel}, speaker: ${speakerId}, state: ${orchestrator.getState()})\n` +
      "コマンド: /quit /heartbeat /state <値>\n" +
      "別プロセス: npm run heartbeat\n" +
      "起動オプション: --verbose (-v, 全文ログ) --quiet (-q, 既定) --user <id> --memory-only --voice",
  );

  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) continue;
      if (line === "/quit") break;

      if (line === "/heartbeat") {
        try {
          const result = await orchestrator.run({ type: "heartbeat" });
          if (verbose.enabled) {
            console.error(
              `[verbose] heartbeat: speech=${!!result.speech} episodeSaved=${result.episodeSaved}`,
            );
          }
          printTurnSummary(result, verbose);
        } catch (err) {
          console.error(err instanceof Error ? err.message : err);
        }
        continue;
      }

      if (line.startsWith("/state ")) {
        orchestrator.setState(line.slice(7).trim());
        console.log(`state = ${orchestrator.getState()}`);
        continue;
      }

      try {
        const result = await orchestrator.run({
          type: "user_message",
          content: line,
          speakerId,
        });
        printTurnSummary(result, verbose);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
