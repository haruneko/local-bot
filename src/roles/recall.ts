import { actionSucceeded } from "../action/outcome.js";
import type { RunActionInput } from "../action/context.js";
import type { LlmClient } from "../llm/types.js";
import { summarizeRecallActionHits } from "../recall/llm-present.js";
import type { ActionOutcome } from "../types.js";

function daysAgoToIso(daysAgo: number, now = new Date()): string {
  return new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
}

export async function runRecall(
  llm: LlmClient,
  input: RunActionInput,
  query?: string,
): Promise<ActionOutcome> {
  const action = input.action;
  query = (query ?? action.intent).trim() || ".";
  const now = new Date();
  const since = action.timeRange?.sinceDaysAgo !== undefined
    ? daysAgoToIso(action.timeRange.sinceDaysAgo, now)
    : undefined;
  const until = action.timeRange?.untilDaysAgo !== undefined
    ? daysAgoToIso(action.timeRange.untilDaysAgo, now)
    : undefined;
  const rawHits = await input.episodes.recall(
    query,
    input.episodeRecallTopK,
    undefined,
    input.ctx.state,
    since,
    until,
  );
  const maxDist = input.explicitRecallMaxDistance ?? 0.40;
  const hits = rawHits.filter((h) => h.distance <= maxDist);

  if (hits.length === 0) {
    return actionSucceeded(action, "記憶を探してみたが、それらしい記憶は見当たらなかった");
  }

  const bullets = await summarizeRecallActionHits(llm, query, hits);

  return actionSucceeded(action, { kind: "recall", bullets });
}
