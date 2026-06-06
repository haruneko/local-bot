import type { ActionErrorInfo } from "./error.js";
import type { ActionFacts } from "./facts.js";
import { formatActionSummary } from "./present.js";
import type { ActionOutcome } from "../types.js";
import type { AbstractAction } from "./types.js";
import { formatFailureSummary } from "./error.js";

export function notAttempted(): ActionOutcome {
  return { attempted: false };
}

export function actionSucceeded(
  action: AbstractAction,
  result: ActionFacts | string,
): ActionOutcome {
  if (typeof result === "string") {
    return {
      attempted: true,
      kind: action.kind,
      intent: action.intent,
      status: "succeeded",
      summary: result,
    };
  }
  return {
    attempted: true,
    kind: action.kind,
    intent: action.intent,
    status: "succeeded",
    facts: result,
    summary: formatActionSummary(result),
  };
}

export function actionFailed(
  action: AbstractAction,
  headline: string,
  error: ActionErrorInfo,
): ActionOutcome {
  return {
    attempted: true,
    kind: action.kind,
    intent: action.intent,
    status: "failed",
    summary: formatFailureSummary(headline, error),
    error,
  };
}
