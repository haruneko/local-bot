import type { ActorRunner } from "./types.js";
import { runMemoRead } from "../roles/memo-read.js";

export const memoReadActor: ActorRunner = {
  name: "memoRead",
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runMemoRead(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
