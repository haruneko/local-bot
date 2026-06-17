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
  /** result が文字列（facts 無しの成功＝空振り等）のときの op。facts ありなら facts.kind を採る。 */
  op?: ActionFacts["kind"],
): ActionOutcome {
  if (typeof result === "string") {
    return {
      attempted: true,
      kind: action.kind,
      intent: action.intent,
      status: "succeeded",
      op,
      summary: result,
    };
  }
  return {
    attempted: true,
    kind: action.kind,
    intent: action.intent,
    status: "succeeded",
    op: result.kind,
    facts: result,
    summary: formatActionSummary(result),
  };
}

export function actionFailed(
  action: AbstractAction,
  headline: string,
  error: ActionErrorInfo,
  /** 失敗した op（recall/memo_write/…）。失敗時も op 別の文言を出すために載せる。 */
  op?: ActionFacts["kind"],
): ActionOutcome {
  return {
    attempted: true,
    kind: action.kind,
    intent: action.intent,
    status: "failed",
    op,
    summary: formatFailureSummary(headline, error),
    error,
  };
}
