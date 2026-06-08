import type { ActorRunner } from "./types.js";
import { runForget } from "../roles/forget.js";

export const forgetActor: ActorRunner = {
  name: "forget",
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runForget(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
