import { renderLanguageUserContent, type TurnContext } from "../context/turn-context.js";
import {
  LANGUAGE_HEARTBEAT_SYSTEM_PREFIX,
  LANGUAGE_SYSTEM_PREFIX,
} from "../prompts/roles.js";
import type { LlmClient } from "../llm/types.js";

export async function runLanguage(
  llm: LlmClient,
  ctx: TurnContext,
): Promise<string> {
  const persona = ctx.persona ?? "";
  const userContent = renderLanguageUserContent(ctx);
  const systemPrefix =
    ctx.trigger.type === "heartbeat"
      ? LANGUAGE_HEARTBEAT_SYSTEM_PREFIX
      : LANGUAGE_SYSTEM_PREFIX;

  return llm.chat(
    [
      {
        role: "system",
        content: `${systemPrefix}\n\n## キャラクタールール\n${persona}`,
      },
      { role: "user", content: userContent },
    ],
    { temperature: ctx.trigger.type === "heartbeat" ? 0.6 : 0.8 },
  );
}
