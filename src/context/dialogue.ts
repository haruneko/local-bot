import type { ConversationTurn } from "../types.js";
import { formatRelativeTime } from "../sensor/datetime.js";

/** 作業記憶・コンテキスト上のボット発話ラベル（一人称ではない） */
export const BOT_SPEAKER_LABEL = "自分";

export type SpeakerProfile = {
  displayName: string;
  note?: string;
};

export type DialogueFormatOptions = {
  resolveUserDisplayName: (speakerId: string) => string;
  /** 話者の関係性プロフィール（言語野の「## 相手について」用）。未設定なら注入しない */
  resolveUserProfile?: (speakerId: string) => SpeakerProfile;
};

export function formatDialogueTurn(
  turn: ConversationTurn,
  opts: DialogueFormatOptions,
  now?: Date,
): string {
  const timeLabel = turn.createdAt && now
    ? ` [${formatRelativeTime(turn.createdAt, now)}]`
    : "";
  if (turn.role === "user") {
    const name = opts.resolveUserDisplayName(turn.speakerId ?? "user");
    return `${name}${timeLabel}: ${turn.content}`;
  }
  if (turn.channel === "monologue") {
    return `${BOT_SPEAKER_LABEL}（独り言）${timeLabel}: ${turn.content}`;
  }
  return `${BOT_SPEAKER_LABEL}${timeLabel}: ${turn.content}`;
}

export function formatWorkingMemoryDialogue(
  turns: readonly ConversationTurn[],
  opts: DialogueFormatOptions,
  now?: Date,
): string {
  if (turns.length === 0) return "（まだ会話はない）";

  const header = [
    "（凡例）",
    `- 「${BOT_SPEAKER_LABEL}:」はあなた自身の過去の発話（ユーザー向け）`,
    `- 「${BOT_SPEAKER_LABEL}（独り言）:」はハートビート時の独り言（相手はいない）`,
    "- 「名前:」は会話相手の発話",
    "",
  ].join("\n");

  const lines = turns.map((t) => formatDialogueTurn(t, opts, now));
  return `${header}${lines.join("\n\n")}`;
}
