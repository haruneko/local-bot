import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runForget } from "../roles/forget.js";

export const forgetActor: ActorRunner = {
  name: "forget",
  activate: createActivate("forget", "ユーザーが削除・修正を求めた記憶を LanceDB からソフト削除する"),
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runForget(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
