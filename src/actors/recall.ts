import type { ActorRunner } from "./types.js";
import { runRecallLoop } from "../roles/agents/memory.js";

export const recallActor: ActorRunner = {
  name: "recall",
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent, timeRange: input.timeRange };
    return runRecallLoop(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
