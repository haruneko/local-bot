import { createApp } from "../app/bootstrap.js";
import { parseArgs } from "./args.js";
import { printTurnSummary } from "./output.js";
import { loadSettings, resolveVoiceSettings } from "../config/settings.js";
import { createVoiceOutputChannel } from "../voice/channel.js";

/** 既定の話者。クロ（開発を手伝う相棒の AI）として話す */
const DEFAULT_SPEAKER = "claude_kuro";

const FLAGS = new Set([
  "--memory-only",
  "--verbose",
  "-v",
  "--quiet",
  "-q",
  "--voice",
]);

/** --user <id> とフラグ以外の位置引数を本文として連結する */
function extractMessage(argv: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--user") {
      i++; // 次トークンは話者 ID なのでスキップ
      continue;
    }
    if (FLAGS.has(a)) continue;
    parts.push(a);
  }
  return parts.join(" ").trim();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const content = extractMessage(argv);
  if (!content) {
    console.error(
      '使い方: npm run say -- [--user <id>] [--memory-only] [-v] [--voice] "メッセージ"',
    );
    process.exit(1);
  }

  const speakerId = args.speakerId ?? DEFAULT_SPEAKER;
  console.error(`say: 接続中… (話者: ${speakerId})`);

  // 音声チャンネルの判断: --voice フラグ または settings.voice.enabled
  const settings = await loadSettings();
  const voiceCfg = resolveVoiceSettings(settings);
  const useVoice = args.voice === true || voiceCfg.enabled;

  // 口の効果器: 発話＋成果物を即出力（push）。単発 CLI でも出力路を効果器に揃える（特別経路を作らない）。
  const voiceChannel = useVoice
    ? createVoiceOutputChannel({
        print: (text) => console.log(text),
        printArtifact: (text) => console.log(text),
        voice: { host: voiceCfg.host, speaker: voiceCfg.speaker },
      })
    : null;

  const outputChannel = voiceChannel ?? {
    say: (speech: string | null, artifacts: string[]) => {
      if (speech) console.log(speech);
      for (const artifact of artifacts) console.log(`\n${artifact}`);
    },
  };

  const app = await createApp({
    speakerId,
    memory: args.memory,
    logLevel: args.logLevel ?? "info",
    // --memory-only は完全な使い捨て: state.json（作業記憶・内心）も持続しない
    statePath: args.memory === "memory" ? false : undefined,
    outputChannel,
  });
  const { orchestrator, verbose } = app;

  const result = await orchestrator.run({
    type: "user_message",
    content,
    speakerId,
  });
  printTurnSummary(result, verbose);

  // 音声キューが残っていれば終わるまで待ってからプロセス終了
  if (voiceChannel) {
    await voiceChannel.flush();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
