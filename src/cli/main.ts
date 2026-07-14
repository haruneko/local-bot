import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createApp } from "../app/bootstrap.js";
import { parseArgs } from "./args.js";
import { printTurnSummary } from "./output.js";
import { loadSettings, resolveVoiceSettings, resolveSttSettings } from "../config/settings.js";
import { createVoiceOutputChannel } from "../voice/channel.js";
import { transcribe } from "../voice/stt.js";
import { startRecording, makeTempWavPath } from "../voice/record.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log("接続中… (Ollama / LanceDB)");

  // 音声チャンネルの判断: --voice / --talk フラグ または settings.voice.enabled
  const settings = await loadSettings();
  const voiceCfg = resolveVoiceSettings(settings);
  const sttCfg = resolveSttSettings(settings);
  const useVoice = args.voice === true || voiceCfg.enabled;
  const useTalk = args.talk === true;

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
  const talkHint = useTalk ? " --talk（空行で録音開始）" : "";
  console.log(
    `${verboseHint}local-bot (${settings.chatModel}, speaker: ${speakerId}, state: ${orchestrator.getState()})\n` +
      "コマンド: /quit /heartbeat /state <値>\n" +
      "別プロセス: npm run heartbeat\n" +
      `起動オプション: --verbose (-v, 全文ログ) --quiet (-q, 既定) --user <id> --memory-only --voice --talk${talkHint}`,
  );

  // --talk モードの録音状態管理
  type RecordingState =
    | { active: false }
    | { active: true; handle: ReturnType<typeof startRecording> };
  let recording: RecordingState = { active: false };

  try {
    while (true) {
      const line = (await rl.question("> ")).trim();

      // --talk モード: 空行で録音トグル
      if (useTalk && !line) {
        if (!recording.active) {
          // 録音開始
          const wavPath = makeTempWavPath();
          let handle: ReturnType<typeof startRecording>;
          try {
            handle = startRecording(wavPath);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            continue;
          }
          recording = { active: true, handle };
          console.log("● 録音中… もう一度 Enter で送信");
        } else {
          // 録音停止 → 文字起こし → ターン実行
          const { handle } = recording;
          recording = { active: false };

          let wav: Buffer;
          try {
            wav = await handle.stop();
          } catch (err) {
            console.error(`録音停止エラー: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }

          let text: string;
          try {
            text = await transcribe(wav, sttCfg);
          } catch (err) {
            console.error(`文字起こしエラー: ${err instanceof Error ? err.message : String(err)}`);
            console.log("聞き取れなかった");
            continue;
          }

          if (!text) {
            console.log("聞き取れなかった");
            continue;
          }

          console.log(`（きこえた: ${text}）`);

          // wav を base64 に変換して audio に載せる
          const b64 = wav.toString("base64");

          try {
            const result = await orchestrator.run({
              type: "user_message",
              content: text,
              speakerId,
              audio: [b64],
            });
            printTurnSummary(result, verbose);
          } catch (err) {
            console.error(err instanceof Error ? err.message : err);
          }
        }
        continue;
      }

      // --talk モードでも非空行はテキストとして送る（録音中でなければ）
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
