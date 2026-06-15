import { App as BoltApp } from "@slack/bolt";
import { createApp } from "../app/bootstrap.js";
import { parseArgs } from "./args.js";
import { printTurnSummary } from "./output.js";

const DEFAULT_HEARTBEAT_MS = 60 * 60 * 1000;

type SlackFile = {
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log("接続中… (Ollama / LanceDB)");
  const app = await createApp({
    speakerId: args.speakerId,
    memory: args.memory,
    logLevel: args.logLevel ?? "info",
  });
  const { orchestrator, verbose } = app;

  const botToken = process.env.SLACK_BOT_TOKEN ?? "";
  const bolt = new BoltApp({
    token: botToken,
    appToken: process.env.SLACK_APP_TOKEN ?? "",
    socketMode: true,
  });

  // Slack の添付画像を bot トークンで DL → base64（文字起こししない・生のまま image_feed へ）。
  // files:read スコープが無い/DL 失敗時は黙ってスキップ＝テキストとして続行（壊さない）。
  async function downloadSlackImages(files: SlackFile[] | undefined): Promise<string[]> {
    if (!files?.length || !botToken) return [];
    const out: string[] = [];
    for (const f of files) {
      if (!f.mimetype?.startsWith("image/")) continue;
      const url = f.url_private_download ?? f.url_private;
      if (!url) continue;
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${botToken}` },
        });
        if (!res.ok) continue;
        out.push(Buffer.from(await res.arrayBuffer()).toString("base64"));
      } catch {
        // スコープ未付与・DL 失敗 → スキップ
      }
    }
    return out;
  }

  async function handleMessage(
    text: string,
    userId: string,
    images: string[],
    reply: (t: string) => Promise<unknown>,
  ): Promise<void> {
    const content = text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!content && images.length === 0) return;

    const result = await orchestrator.run({
      type: "user_message",
      content,
      speakerId: userId,
      images: images.length > 0 ? images : undefined,
    });

    printTurnSummary(result, verbose);

    if (result.speech) await reply(result.speech);
    // 成果物（生成物・調査結果・読み上げ）は speech とは別に全文を投稿する（チャットチャンネル）
    for (const artifact of result.artifacts) await reply(artifact);
  }

  // DM のみ（チャンネルは app_mention で処理するため channel_type で絞る）
  bolt.message(async ({ message, say }) => {
    const m = message as {
      subtype?: string;
      channel_type?: string;
      text?: string;
      user?: string;
      files?: SlackFile[];
    };
    // 通常メッセージ＋画像添付（file_share）だけ通す。編集・bot 発言などの他 subtype は無視。
    if (m.subtype !== undefined && m.subtype !== "file_share") return;
    if (m.channel_type !== "im") return;
    const user = m.user;
    if (!user) return;
    const images = await downloadSlackImages(m.files);
    await handleMessage(m.text ?? "", user, images, (t) => say(t));
  });

  // チャンネルでの @メンション
  bolt.event("app_mention", async ({ event, say }) => {
    const user = event.user;
    if (!user) return;
    const images = await downloadSlackImages(
      (event as { files?: SlackFile[] }).files,
    );
    await handleMessage(event.text ?? "", user, images, (t) => say(t));
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
