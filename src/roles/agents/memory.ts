import type { RunActionInput } from "../../action/context.js";
import type { ActionOutcome } from "../../types.js";
import type { LlmClient } from "../../llm/types.js";
import { actionSucceeded } from "../../action/outcome.js";
import { runRecall } from "../recall.js";
import { runSubagentToolPick } from "../subagent.js";

const MAX_RECALL_STEPS = 3;

const RECALL_ONLY_CATALOG = [
  {
    name: "recall",
    description: "LanceDB 記憶から意識的に掘り出す。引数: {query: 検索クエリ（省略時は intent を使う）}",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    category: "memory" as const,
    source: "in-process" as const,
  },
];

export async function runRecallLoop(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.action;
  const allBullets: string[] = [];
  const priorSteps: string[] = [];
  let currentQuery = action.intent.trim() || ".";

  for (let step = 0; step < MAX_RECALL_STEPS; step++) {
    const outcome = await runRecall(llm, input, currentQuery);

    if (!outcome.attempted) {
      return step === 0 ? outcome : actionSucceeded(action, { kind: "recall", bullets: allBullets });
    }

    if (outcome.status === "succeeded" && outcome.facts?.kind === "recall") {
      const newBullets = outcome.facts.bullets;
      allBullets.push(...newBullets);
      priorSteps.push(
        `recall("${currentQuery}"): ${newBullets.length}件 — ${newBullets.slice(0, 2).join(" / ")}`,
      );
    } else {
      priorSteps.push(`recall("${currentQuery}"): 0件`);
    }

    const pick = await runSubagentToolPick(llm, {
      category: "memory",
      intent: action.intent,
      catalog: RECALL_ONLY_CATALOG,
      ctx: input.ctx,
      priorSteps,
    });

    if (pick.done || pick.tool !== "recall") break;

    const nextQuery = String(pick.arguments?.query ?? "").trim();
    if (!nextQuery || nextQuery === currentQuery) break;
    currentQuery = nextQuery;
  }

  if (allBullets.length === 0) {
    return actionSucceeded(action, "記憶を探したが、思い当たるものは無かった");
  }
  return actionSucceeded(action, { kind: "recall", bullets: [...new Set(allBullets)] });
}
