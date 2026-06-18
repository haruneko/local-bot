import { App as BoltApp } from "@slack/bolt";
import { createApp } from "../app/bootstrap.js";
import { parseArgs } from "./args.js";
import { printTurnSummary } from "./output.js";
import { normalizeImage } from "../sensor/image.js";

const DEFAULT_HEARTBEAT_MS = 60 * 60 * 1000;
/** これを超える成果物は inline で流さず Slack snippet（折りたたみ添付）にする */
const ARTIFACT_INLINE_MAX = 1200;

type SlackFile = {
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log("接続中… (Ollama / LanceDB)");

  // 口の効果器: orchestrator は常駐だが出力先（channel/reply）は毎ターン可変なので、
  // ターン直前にセットする可変 sink を closure で持たせる（発話直後に push される）。
  let activeSink:
    | ((speech: string | null, artifacts: string[]) => Promise<void>)
    | null = null;
  const outputChannel = {
    say: async (speech: string | null, artifacts: string[]) => {
      if (activeSink) await activeSink(speech, artifacts);
    },
  };

  const app = await createApp({
    speakerId: args.speakerId,
    memory: args.memory,
    logLevel: args.logLevel ?? "info",
    outputChannel,
  });
  const { orchestrator, verbose, settings } = app;

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
        const raw = Buffer.from(await res.arrayBuffer()).toString("base64");
        out.push(await normalizeImage(raw, settings.imageMaxLongSide));
      } catch {
        // スコープ未付与・DL 失敗 → スキップ
      }
    }
    return out;
  }

  // 成果物の投稿: 短いものは通常メッセージ、長いものは Slack snippet（折りたたみ添付）で
  // チャットを流さない。snippet 失敗時は通常投稿にフォールバック（壊さない）。
  async function postArtifact(channel: string, text: string): Promise<void> {
    if (text.length <= ARTIFACT_INLINE_MAX) {
      await bolt.client.chat.postMessage({ channel, text });
      return;
    }
    try {
      await bolt.client.files.uploadV2({
        channel_id: channel,
        content: text,
        filename: "result.md",
        title: "（長い成果物）",
      });
    } catch {
      await bolt.client.chat.postMessage({ channel, text });
    }
  }

  async function handleMessage(
    text: string,
    userId: string,
    images: string[],
    channel: string,
    reply: (t: string) => Promise<unknown>,
  ): Promise<void> {
    const content = text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!content && images.length === 0) return;

    // 発話直後に push（async-reflect）: 発話＝reply、成果物＝別経路（長尺は snippet で流さない）。
    activeSink = async (speech, artifacts) => {
      if (speech) await reply(speech);
      for (const artifact of artifacts) await postArtifact(channel, artifact);
    };
    try {
      const result = await orchestrator.run({
        type: "user_message",
        content,
        speakerId: userId,
        images: images.length > 0 ? images : undefined,
      });
      printTurnSummary(result, verbose);
    } finally {
      activeSink = null;
    }
  }

  // DM のみ（チャンネルは app_mention で処理するため channel_type で絞る）
  bolt.message(async ({ message, say }) => {
    const m = message as {
      subtype?: string;
      channel_type?: string;
      channel?: string;
      text?: string;
      user?: string;
      files?: SlackFile[];
    };
    // 通常メッセージ＋画像添付（file_share）だけ通す。編集・bot 発言などの他 subtype は無視。
    if (m.subtype !== undefined && m.subtype !== "file_share") return;
    if (m.channel_type !== "im") return;
    const user = m.user;
    if (!user || !m.channel) return;
    const images = await downloadSlackImages(m.files);
    await handleMessage(m.text ?? "", user, images, m.channel, (t) => say(t));
  });

  // チャンネルでの @メンション
  bolt.event("app_mention", async ({ event, say }) => {
    const user = event.user;
    if (!user || !event.channel) return;
    const images = await downloadSlackImages(
      (event as { files?: SlackFile[] }).files,
    );
    await handleMessage(event.text ?? "", user, images, event.channel, (t) => say(t));
  });

  // heartbeat: SLACK_HEARTBEAT_CHANNEL が設定されていれば定期実行
  const heartbeatChannel = process.env.SLACK_HEARTBEAT_CHANNEL;
  if (heartbeatChannel) {
    const intervalMs =
      parseInt(process.env.SLACK_HEARTBEAT_INTERVAL_MS ?? "", 10) ||
      DEFAULT_HEARTBEAT_MS;

    setInterval(async () => {
      activeSink = async (speech, artifacts) => {
        if (speech) {
          await bolt.client.chat.postMessage({ channel: heartbeatChannel, text: speech });
        }
        for (const artifact of artifacts) await postArtifact(heartbeatChannel, artifact);
      };
      try {
        const result = await orchestrator.run({ type: "heartbeat" });
        printTurnSummary(result, verbose);
      } catch (err) {
        console.error(
          "[heartbeat] エラー:",
          err instanceof Error ? err.message : err,
        );
      } finally {
        activeSink = null;
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
