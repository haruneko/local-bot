import type { ActorRunner } from "./types.js";
import { runRemember } from "../roles/remember.js";

export const rememberActor: ActorRunner = {
  name: "remember",
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runRemember(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
