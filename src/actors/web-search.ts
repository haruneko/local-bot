import type { ActorRunner } from "./types.js";
import { runResearchSubagent } from "../roles/subagent.js";

export const webSearchActor: ActorRunner = {
  name: "webSearch",
  run: (llm, input) => {
    const action = { kind: "research" as const, intent: input.intent };
    return runResearchSubagent(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
