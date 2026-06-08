import type { TurnContext } from "../context/turn-context.js";
import type { LlmClient } from "../llm/types.js";
import { generateDialogueSpeech, type LanguageOutput } from "./language-faculty.js";

export type { LanguageOutput } from "./language-faculty.js";

export async function runLanguage(
  llm: LlmClient,
  ctx: TurnContext,
  defaultNumPredict = 400,
): Promise<LanguageOutput> {
  return generateDialogueSpeech(llm, ctx, defaultNumPredict);
}
