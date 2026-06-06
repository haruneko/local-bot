import { isActionAttempted } from "../action/types.js";
import type { RunActionInput } from "../action/context.js";
import { notAttempted } from "../action/outcome.js";
import type { LlmClient } from "../llm/types.js";
import type { ActionOutcome } from "../types.js";
import { runRemember } from "./remember.js";
import { runRecall } from "./recall.js";
import { runMemoWrite } from "./memo-write.js";
import { runMemoRead } from "./memo-read.js";

export type { RunActionInput, RunActionDeps } from "../action/context.js";

export async function runAction(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.ctx.judge?.ACTION;
  if (!action || !isActionAttempted(action)) {
    return notAttempted();
  }

  switch (action.kind) {
    case "remember":
      return runRemember(llm, input);
    case "recall":
      return runRecall(llm, input);
    case "memo_write":
      return runMemoWrite(llm, input);
    case "memo_read":
      return runMemoRead(llm, input);
    default:
      return notAttempted();
  }
}
