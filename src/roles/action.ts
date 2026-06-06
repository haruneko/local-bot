import { isActionAttempted } from "../action/types.js";
import type { RunActionInput } from "../action/context.js";
import { notAttempted } from "../action/outcome.js";
import type { LlmClient } from "../llm/types.js";
import type { ActionOutcome } from "../types.js";
import { runCategorySubagent } from "./subagent.js";

export type { RunActionInput, RunActionDeps } from "../action/context.js";

export async function runAction(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.ctx.judge?.ACTION;
  if (!action || !isActionAttempted(action)) {
    return notAttempted();
  }

  return runCategorySubagent(llm, input);
}
