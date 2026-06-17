import { actionSucceeded } from "../action/outcome.js";
import type { RunActionInput } from "../action/context.js";
import type { ActionOutcome } from "../types.js";

function daysAgoToIso(daysAgo: number, now = new Date()): string {
  return new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
}

export async function runRecall(
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
  const maxDist = input.explicitRecallMaxDistance ?? 0.45;
  const hits = rawHits.filter((h) => h.distance <= maxDist);

  if (hits.length === 0) {
    return actionSucceeded(action, "記憶を探したが、思い当たるものは無かった");
  }

  // ベクトル検索でヒットした上位を機械的にそのまま提示する（LLM 要約しない＝
  // 想起の二度手間・劣化・遅延を避ける。距離の近い順に top-2 の本文をそのまま渡す）。
  const bullets = hits.slice(0, 2).map((h) => h.body.trim()).filter(Boolean);

  return actionSucceeded(action, { kind: "recall", bullets });
}
