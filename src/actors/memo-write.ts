import type { ActorRunner } from "./types.js";
import { runMemoWrite } from "../roles/memo-write.js";

export const memoWriteActor: ActorRunner = {
  name: "memoWrite",
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runMemoWrite(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
