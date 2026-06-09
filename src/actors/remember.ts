import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runRemember } from "../roles/remember.js";

export const rememberActor: ActorRunner = {
  name: "remember",
  activate: createActivate("remember", "会話で新たに判明した事実・情報を LanceDB に記録する"),
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runRemember(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
