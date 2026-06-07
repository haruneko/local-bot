import { withJudge } from "../../context/turn-context.js";
import type { RunActionInput } from "../../action/context.js";
import type { ActionOutcome } from "../../types.js";
import type { AbstractAction } from "../../action/types.js";
import type { MemoryToolKind } from "../../tools/catalog.js";
import { MEMORY_TOOL_KINDS } from "../../tools/catalog.js";
import type { LlmClient } from "../../llm/types.js";
import { actionFailed, actionSucceeded } from "../../action/outcome.js";
import { ACTION_ERROR_CODES } from "../../action/error.js";
import { runRemember } from "../remember.js";
import { runRecall } from "../recall.js";
import { runForget } from "../forget.js";
import { runMemoWrite } from "../memo-write.js";
import { runMemoRead } from "../memo-read.js";
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

async function runRecallLoop(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.ctx.judge!.ACTION;
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
    return actionSucceeded(action, "（該当する記憶は見つからなかった）");
  }
  return actionSucceeded(action, { kind: "recall", bullets: [...new Set(allBullets)] });
}

function isMemoryToolKind(name: string): name is MemoryToolKind {
  return (MEMORY_TOOL_KINDS as readonly string[]).includes(name);
}

function remapToCategory(
  parent: AbstractAction,
  outcome: ActionOutcome,
): ActionOutcome {
  if (!outcome.attempted) return outcome;
  return { ...outcome, kind: parent.kind, intent: parent.intent };
}

function withMemoryTool(
  input: RunActionInput,
  tool: MemoryToolKind,
): RunActionInput {
  const judge = input.ctx.judge!;
  const synthetic = withJudge(input.ctx, {
    ...judge,
    ACTION: {
      kind: tool,
      intent: judge.ACTION.intent,
    } as unknown as AbstractAction,
  });
  return { ...input, ctx: synthetic };
}

export async function runMemorySubagent(
  llm: LlmClient,
  input: RunActionInput,
  pickedTool?: string,
): Promise<ActionOutcome> {
  const action = input.ctx.judge!.ACTION;
  let toolName = pickedTool;
  if (!toolName) {
    const pick = await runSubagentToolPick(llm, {
      category: "memory",
      intent: action.intent,
      catalog: (input.toolCatalog ?? []).filter((t) => t.category === "memory"),
      ctx: input.ctx,
    });
    if (pick.done || !pick.tool) {
      return actionFailed(action, "記憶ツールを選べなかった", {
        code: ACTION_ERROR_CODES.PICK_FAILED,
        message: pick.reason ?? "サブエージェントがツールを返さなかった",
      });
    }
    toolName = pick.tool;
  }

  if (!isMemoryToolKind(toolName)) {
    return actionFailed(action, "記憶ツールを選べなかった", {
      code: ACTION_ERROR_CODES.PICK_FAILED,
      message: `未知の記憶ツール: ${toolName}`,
    });
  }

  if (toolName === "distill") {
    return actionSucceeded(
      action,
      "意味記憶への蒸留は `npm run dream` で実行する。distill アクションからの起動は未対応。",
    );
  }

  const routed = withMemoryTool(input, toolName);
  let outcome: ActionOutcome;
  switch (toolName) {
    case "remember":
      outcome = await runRemember(llm, routed);
      break;
    case "recall":
      outcome = await runRecallLoop(llm, routed);
      break;
    case "forget":
      outcome = await runForget(llm, routed);
      break;
    case "memo_write":
      outcome = await runMemoWrite(llm, routed);
      break;
    case "memo_read":
      outcome = await runMemoRead(llm, routed);
      break;
    default:
      return actionFailed(action, "記憶ツールの実行に失敗した", {
        code: ACTION_ERROR_CODES.ACTION_DISCONNECTED,
        message: `未接続: ${toolName}`,
      });
  }
  return remapToCategory(action, outcome);
}
