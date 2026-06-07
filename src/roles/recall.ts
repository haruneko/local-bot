import { actionSucceeded } from "../action/outcome.js";
import type { RunActionInput } from "../action/context.js";
import type { LlmClient } from "../llm/types.js";
import { summarizeRecallActionHits } from "../recall/llm-present.js";
import type { ActionOutcome } from "../types.js";

export async function runRecall(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.ctx.judge!.ACTION;
  const query = action.intent.trim() || ".";
  const hits = await input.episodes.recall(
    query,
    input.episodeRecallTopK,
    undefined,
    input.ctx.state,
  );

  if (hits.length === 0) {
    return actionSucceeded(action, "（該当する記憶は見つからなかった）");
  }

  const bullets = await summarizeRecallActionHits(llm, query, hits);

  return actionSucceeded(action, { kind: "recall", bullets });
}
