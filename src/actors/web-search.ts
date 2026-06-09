import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runResearchSubagent } from "../roles/subagent.js";

export const webSearchActor: ActorRunner = {
  name: "webSearch",
  activate: createActivate("webSearch", "Web 検索・外部 API で情報を取得する（直近の会話に情報検索の意図があるか）"),
  run: (llm, input) => {
    const action = { kind: "research" as const, intent: input.intent };
    return runResearchSubagent(llm, { ctx: input.ctx, action, ...input.deps });
  },
};

export const urlBrowseActor: ActorRunner = {
  name: "urlBrowse",
  activate: createActivate("urlBrowse", "URL を直接閲覧して内容を取得する（会話に URL または明示的な参照先がある場合）"),
  run: (llm, input) => {
    const action = { kind: "research" as const, intent: input.intent };
    return runResearchSubagent(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
