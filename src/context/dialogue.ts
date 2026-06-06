import type { ConversationTurn } from "../types.js";

/** 作業記憶・コンテキスト上のボット発話ラベル（一人称ではない） */
export const BOT_SPEAKER_LABEL = "自分";

export type DialogueFormatOptions = {
  resolveUserDisplayName: (speakerId: string) => string;
};

export function formatDialogueTurn(
  turn: ConversationTurn,
  opts: DialogueFormatOptions,
): string {
  if (turn.role === "user") {
    const name = opts.resolveUserDisplayName(turn.speakerId ?? "user");
    return `${name}: ${turn.content}`;
  }
  if (turn.channel === "monologue") {
    return `${BOT_SPEAKER_LABEL}（独り言）: ${turn.content}`;
  }
  return `${BOT_SPEAKER_LABEL}: ${turn.content}`;
}

export function formatWorkingMemoryDialogue(
  turns: readonly ConversationTurn[],
  opts: DialogueFormatOptions,
): string {
  if (turns.length === 0) return "（まだ会話はない）";

  const header = [
    "（凡例）",
    `- 「${BOT_SPEAKER_LABEL}:」はあなた自身の過去の発話（ユーザー向け）`,
    `- 「${BOT_SPEAKER_LABEL}（独り言）:」はハートビート時の独り言（相手はいない）`,
    "- 「名前:」は会話相手の発話",
    "",
  ].join("\n");

  const lines = turns.map((t) => formatDialogueTurn(t, opts));
  return `${header}${lines.join("\n\n")}`;
}
