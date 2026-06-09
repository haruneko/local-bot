import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runMemoWrite } from "../roles/memo-write.js";

export const memoWriteActor: ActorRunner = {
  name: "memoWrite",
  activate: createActivate("memoWrite", "重要な情報をメモファイル（data/notes/）に書き込む"),
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runMemoWrite(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
