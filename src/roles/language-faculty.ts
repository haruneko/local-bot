import type { TurnContext } from "../context/turn-context.js";
import { renderLanguageUserContent } from "../context/turn-context.js";
import {
  LANGUAGE_HEARTBEAT_SYSTEM_PREFIX,
  LANGUAGE_SYSTEM_PREFIX,
} from "../prompts/roles.js";
import type { LlmClient } from "../llm/types.js";

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
  const userContent = renderLanguageUserContent(ctx);
  const systemPrefix =
    ctx.trigger.type === "heartbeat"
      ? LANGUAGE_HEARTBEAT_SYSTEM_PREFIX
      : LANGUAGE_SYSTEM_PREFIX;

  return generateLanguageText(llm, {
    persona,
    systemPrefix,
    userContent,
    temperature: ctx.trigger.type === "heartbeat" ? 0.6 : 0.8,
  });
}
