import type { TurnContext } from "../context/turn-context.js";
import {
  buildConversationTurns,
  buildLanguageContextSuffix,
  renderLanguageUserContent,
} from "../context/turn-context.js";
import {
  LANGUAGE_HEARTBEAT_SYSTEM_PREFIX,
  LANGUAGE_SYSTEM_PREFIX,
} from "../prompts/roles.js";
import type { ChatMessage, LlmClient } from "../llm/types.js";
import { formatActionForLanguage } from "../action/present.js";

export type GenerateLanguageOptions = {
  persona: string;
  systemPrefix: string;
  userContent: string;
  temperature?: number;
};

export async function generateLanguageText(
  llm: LlmClient,
  options: GenerateLanguageOptions,
): Promise<string> {
  return llm.chat(
    [
      {
        role: "system",
        content: `${options.systemPrefix}\n\n## キャラクタールール\n${options.persona}`,
      },
      { role: "user", content: options.userContent },
    ],
    { temperature: options.temperature ?? 0.7 },
  );
}

function buildLanguageDialogueMessages(
  ctx: TurnContext,
  systemPrefix: string,
  persona: string,
): ChatMessage[] {
  const partnerName = ctx.dialogue.resolveUserDisplayName(
    ctx.trigger.type === "user_message" ? ctx.trigger.speakerId : "",
  );
  const situationLine = `\n\n状況: ${ctx.state} / ${ctx.currentDateTime} / 相手: ${partnerName}`;
  const systemContent =
    `${systemPrefix}\n\n## キャラクタールール\n${persona}` +
    situationLine +
    buildLanguageContextSuffix(ctx);

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...buildConversationTurns(ctx),
  ];

  const triggerLine =
    ctx.trigger.type === "user_message"
      ? `${partnerName}: ${ctx.trigger.content}`
      : "（ハートビート）";
  const actionText = formatActionForLanguage(ctx.action);
  const userContent = actionText
    ? `${triggerLine}\n\n## このターンで起きたこと\n${actionText}`
    : triggerLine;

  messages.push({ role: "user", content: userContent });
  return messages;
}

export async function generateExpressText(
  llm: LlmClient,
  ctx: TurnContext,
  intent: string,
): Promise<string> {
  const persona = ctx.persona ?? "";
  const base = renderLanguageUserContent(ctx);
  const userContent = [
    base,
    "",
    "【発信の意図】",
    intent,
    "",
    "上記の意図に沿った、外部チャンネル向けの短文を1つだけ書く。",
    "ユーザーへの返答ではなく、投稿・送信向けの本文のみ。",
  ].join("\n");

  return generateLanguageText(llm, {
    persona,
    systemPrefix: LANGUAGE_SYSTEM_PREFIX,
    userContent,
    temperature: 0.7,
  });
}

export async function generateDialogueSpeech(
  llm: LlmClient,
  ctx: TurnContext,
): Promise<string> {
  const persona = ctx.persona ?? "";

  if (ctx.trigger.type === "heartbeat") {
    const userContent = renderLanguageUserContent(ctx);
    return generateLanguageText(llm, {
      persona,
      systemPrefix: LANGUAGE_HEARTBEAT_SYSTEM_PREFIX,
      userContent,
      temperature: 0.6,
    });
  }

  const messages = buildLanguageDialogueMessages(ctx, LANGUAGE_SYSTEM_PREFIX, persona);
  return llm.chat(messages, { temperature: 0.8 });
}
