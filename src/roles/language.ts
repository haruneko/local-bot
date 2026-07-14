import type { TurnContext } from "../context/turn-context.js";
import type { LlmClient } from "../llm/types.js";
import {
  generateDialogueSpeech,
  generateDialogueSpeechStream,
  type LanguageOutput,
} from "./language-faculty.js";

export type { LanguageOutput } from "./language-faculty.js";

export async function runLanguage(
  llm: LlmClient,
  ctx: TurnContext,
  defaultNumPredict = 400,
): Promise<LanguageOutput> {
  return generateDialogueSpeech(llm, ctx, defaultNumPredict);
}

/** 発話をストリーミング生成し、文が確定するたび onSentence へ流す。正本は返り値（全文 parse）。 */
export async function runLanguageStream(
  llm: LlmClient,
  ctx: TurnContext,
  onSentence: (sentence: string) => void,
  defaultNumPredict = 400,
): Promise<LanguageOutput> {
  return generateDialogueSpeechStream(llm, ctx, onSentence, defaultNumPredict);
}
