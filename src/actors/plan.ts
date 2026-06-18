import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runPlan } from "../roles/plan.js";

const PLAN_ACTIVATE_PROMPT = [
  "会話を読み、遂行に計画（目標・タスク一覧）を作る／更新する必要があるかを判断してください。学習・制作・調査など、複数ステップを要するときに計画します。",
  "",
  '- 計画の要る複雑なタスクを依頼された → { "active": true, "intent": "..." }',
  '- 集中作業中で進捗・状態が変わった → { "active": true, "intent": "..." }',
  '- どれも不要 → { "active": false }',
].join("\n");

export const planActor: ActorRunner = {
  name: "plan",
  activate: createActivate("plan", "", { systemPrompt: PLAN_ACTIVATE_PROMPT }),
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runPlan(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
