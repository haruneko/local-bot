import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runRecallLoop } from "../roles/agents/memory.js";

export const recallActor: ActorRunner = {
  name: "recall",
  activate: createActivate("recall", "LanceDB から過去のエピソード記憶を検索・引き出す"),
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent, timeRange: input.timeRange };
    return runRecallLoop(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
