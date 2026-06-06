import type { TurnContext } from "../context/turn-context.js";
import type { LlmClient } from "../llm/types.js";
import { generateDialogueSpeech } from "./language-faculty.js";

export async function runLanguage(
  llm: LlmClient,
  ctx: TurnContext,
): Promise<string> {
  return generateDialogueSpeech(llm, ctx);
}
