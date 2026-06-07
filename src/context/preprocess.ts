import { SUMMARIZE_SYSTEM } from "../prompts/roles.js";
import type { LlmClient } from "../llm/types.js";
import {
  serializeMemoryForBudget,
  type TurnContext,
} from "./turn-context.js";
import { exceedsTokenBudget } from "../util/tokens.js";

export async function fitTurnContext(
  llm: LlmClient,
  draft: TurnContext,
  tokenBudget: number,
): Promise<TurnContext> {
  const serialized = serializeMemoryForBudget(draft);
  if (!exceedsTokenBudget(serialized, tokenBudget)) {
    return draft;
  }

  // Step 1: 作業記憶の古いターンを先頭から削る（LLM 要約しない）
  let ctx: TurnContext = draft;
  while (
    ctx.priorTurns.length > 0 &&
    exceedsTokenBudget(serializeMemoryForBudget(ctx), tokenBudget)
  ) {
    ctx = { ...ctx, priorTurns: ctx.priorTurns.slice(1) };
  }
  if (!exceedsTokenBudget(serializeMemoryForBudget(ctx), tokenBudget)) {
    return ctx;
  }

  // Step 2: それでも足りなければエピソード記憶を LLM 要約（最終手段）
  const recalledText = await summarizeChannel(
    llm,
    "想起エピソード",
    ctx.recalledEpisodes.map((e) => e.presented).join("\n---\n"),
  );

  const semanticFacts =
    ctx.semanticFacts.length > 3
      ? ctx.semanticFacts
          .slice()
          .sort((a, b) => b.relevance - a.relevance)
          .slice(0, 3)
      : ctx.semanticFacts;

  const shrunk: TurnContext = {
    ...ctx,
    recalledEpisodes: recalledText
      ? [{ presented: recalledText, relevance: 1, presentation: "summarize" as const }]
      : [],
    recallDelivery: recalledText ? "summarize" : ctx.recallDelivery,
    semanticFacts,
  };

  if (exceedsTokenBudget(serializeMemoryForBudget(shrunk), tokenBudget)) {
    return truncateTurnContext(shrunk);
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

function truncateTurnContext(ctx: TurnContext): TurnContext {
  return {
    ...ctx,
    priorTurns: [],
    recalledEpisodes: ctx.recalledEpisodes.map((e) => ({
      ...e,
      presented:
        e.presented.length > 500
          ? `${e.presented.slice(0, 500)}…`
          : e.presented,
    })),
  };
}
