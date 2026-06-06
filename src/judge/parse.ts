import { NONE_ACTION, type AbstractAction } from "../action/types.js";
import type { AgentState, JudgeOutput } from "../types.js";
import { judgeOutputSchema } from "./schema.js";

export type ParseJudgeResult =
  | { ok: true; value: JudgeOutput }
  | { ok: false; raw: string; fallback: JudgeOutput };

export function normalizeJudgeAction(
  action: AbstractAction | null,
): AbstractAction {
  if (action === null) return NONE_ACTION;
  if (action.kind === "none") return NONE_ACTION;
  const trimmedIntent = action.intent.trim();
  if (!trimmedIntent) return NONE_ACTION;
  return { kind: action.kind, intent: trimmedIntent };
}

export function parseJudgeJson(
  raw: string,
  currentState: AgentState,
): ParseJudgeResult {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = judgeOutputSchema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        raw,
        fallback: defaultJudgeFallback(currentState),
      };
    }
    return {
      ok: true,
      value: {
        ACTION: normalizeJudgeAction(result.data.ACTION),
        REPLY: result.data.REPLY,
        NEXT_STATE: result.data.NEXT_STATE,
      },
    };
  } catch {
    return {
      ok: false,
      raw,
      fallback: defaultJudgeFallback(currentState),
    };
  }
}

export function defaultJudgeFallback(currentState: AgentState): JudgeOutput {
  return {
    ACTION: NONE_ACTION,
    REPLY: true,
    NEXT_STATE: currentState,
  };
}
