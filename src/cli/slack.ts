import { App as BoltApp } from "@slack/bolt";
import { createApp } from "../app/bootstrap.js";
import { parseArgs } from "./args.js";
import { printTurnSummary } from "./output.js";

const DEFAULT_HEARTBEAT_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log("接続中… (Ollama / LanceDB)");
  const app = await createApp({
    speakerId: args.speakerId,
    memory: args.memory,
    logLevel: args.logLevel ?? "info",
  });
  const { orchestrator, verbose } = app;

  const bolt = new BoltApp({
    token: process.env.SLACK_BOT_TOKEN ?? "",
    appToken: process.env.SLACK_APP_TOKEN ?? "",
    socketMode: true,
  });

  async function handleMessage(
    text: string,
    userId: string,
    reply: (t: string) => Promise<unknown>,
  ): Promise<void> {
    const content = text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!content) return;

    const result = await orchestrator.run({
      type: "user_message",
      content,
      speakerId: userId,
    });

    printTurnSummary(result, verbose);

    if (result.speech) await reply(result.speech);
    // 成果物（生成物・調査結果・読み上げ）は speech とは別に全文を投稿する（チャットチャンネル）
    for (const artifact of result.artifacts) await reply(artifact);
  }

  // DM のみ（チャンネルは app_mention で処理するため channel_type で絞る）
  bolt.message(async ({ message, say }) => {
    if (message.subtype !== undefined) return;
    if (message.channel_type !== "im") return;
    const text = message.text ?? "";
    const user = message.user;
    if (!text || !user) return;
    await handleMessage(text, user, (t) => say(t));
  });

  // チャンネルでの @メンション
  bolt.event("app_mention", async ({ event, say }) => {
    const text = event.text ?? "";
    const user = event.user;
    if (!text || !user) return;
    await handleMessage(text, user, (t) => say(t));
  });

  // heartbeat: SLACK_HEARTBEAT_CHANNEL が設定されていれば定期実行
  const heartbeatChannel = process.env.SLACK_HEARTBEAT_CHANNEL;
  if (heartbeatChannel) {
    const intervalMs =
      parseInt(process.env.SLACK_HEARTBEAT_INTERVAL_MS ?? "", 10) ||
      DEFAULT_HEARTBEAT_MS;

    setInterval(async () => {
      try {
        const result = await orchestrator.run({ type: "heartbeat" });
        printTurnSummary(result, verbose);
        if (result.speech) {
          await bolt.client.chat.postMessage({
            channel: heartbeatChannel,
            text: result.speech,
          });
        }
        for (const artifact of result.artifacts) {
          await bolt.client.chat.postMessage({
            channel: heartbeatChannel,
            text: artifact,
          });
        }
      } catch (err) {
        console.error(
          "[heartbeat] エラー:",
          err instanceof Error ? err.message : err,
        );
      }
    }, intervalMs);

    console.log(
      `heartbeat 有効 (channel: ${heartbeatChannel}, interval: ${intervalMs / 60000}分)`,
    );
  }

  await bolt.start();
  console.log("Slack bot 起動完了 (Socket Mode)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
