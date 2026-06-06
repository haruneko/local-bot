import type { AgentState } from "../types.js";

const KNOWN_STATES = new Set(["対話", "静穏"]);

export function applyNextState(
  _current: AgentState,
  next: string,
): AgentState {
  if (!KNOWN_STATES.has(next)) {
    console.warn(`[state] unknown_state: ${JSON.stringify(next)}`);
  }
  return next;
}
