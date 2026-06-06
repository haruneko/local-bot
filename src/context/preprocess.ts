import { SUMMARIZE_SYSTEM } from "../prompts/roles.js";
import type { LlmClient } from "../llm/types.js";
import {
  formatWorkingMemoryChannel,
  serializeMemoryForBudget,
  type TurnContext,
} from "./turn-context.js";
import { estimateTokens, exceedsTokenBudget } from "../util/tokens.js";

export async function fitTurnContext(
  llm: LlmClient,
  draft: TurnContext,
  tokenBudget: number,
): Promise<TurnContext> {
  const serialized = serializeMemoryForBudget(draft);
  if (!exceedsTokenBudget(serialized, tokenBudget)) {
    return draft;
  }

  const [priorDialogueChannel, recalledText] = await Promise.all([
    summarizeChannel(
      llm,
      "作業記憶",
      formatWorkingMemoryChannel(draft),
    ),
    summarizeChannel(
      llm,
      "想起エピソード",
      draft.recalledEpisodes.map((e) => e.presented).join("\n---\n"),
    ),
  ]);

  const shrunk: TurnContext = {
    ...draft,
    priorDialogueChannel,
    recalledEpisodes: recalledText
      ? [{ presented: recalledText, relevance: 1, presentation: "summarize" as const }]
      : [],
    recallDelivery: recalledText ? "summarize" : draft.recallDelivery,
  };

  if (exceedsTokenBudget(serializeMemoryForBudget(shrunk), tokenBudget)) {
    return truncateTurnContext(shrunk, tokenBudget);
  }
  return shrunk;
}

async function summarizeChannel(
  llm: LlmClient,
  label: string,
  text: string,
): Promise<string> {
  if (!text.trim()) return "";
  return llm.chat(
    [
      { role: "system", content: SUMMARIZE_SYSTEM },
      {
        role: "user",
        content: `チャンネル: ${label}\n\n${text}`,
      },
    ],
    { temperature: 0 },
  );
}

function truncateTurnContext(ctx: TurnContext, budget: number): TurnContext {
  const targetChars = Math.floor(budget * 3 * 0.9);
  let prior = ctx.priorDialogueChannel ?? "";
  if (estimateTokens(prior) > budget / 2) {
    prior = prior.slice(-targetChars);
  }
  return {
    ...ctx,
    priorDialogueChannel: prior,
    recalledEpisodes: ctx.recalledEpisodes.map((e) => ({
      ...e,
      presented:
        e.presented.length > 500
          ? `${e.presented.slice(0, 500)}…`
          : e.presented,
    })),
  };
}
