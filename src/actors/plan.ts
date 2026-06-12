import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runPlan } from "../roles/plan.js";

export const planActor: ActorRunner = {
  name: "plan",
  activate: createActivate(
    "plan",
    "取り組み中のゴールの計画ノート（目標・状態・履歴）を作成/更新する。" +
      "起動するのは、相手が新しい目標・計画を立てたいと言ったとき、" +
      "または集中して作業を進めているターンで進捗・状態が変わったとき。" +
      "雑談・単発の質問・感情のやり取りだけのときは起動しない。",
  ),
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runPlan(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
