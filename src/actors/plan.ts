import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runPlan } from "../roles/plan.js";

export const planActor: ActorRunner = {
  name: "plan",
  activate: createActivate(
    "plan",
    "取り組み中のゴールの計画ノート（目標・状態・履歴）を作成/更新する。" +
      "plan は**段階を踏んで達成する目標**（学習・制作・調査など、複数ステップで進める物）のときだけ。" +
      "**在庫・買い物・リスト・記録の*管理*（足す/消す/確認するだけ）は memo の領分なので plan を作らない**。" +
      "起動するのは、相手が新しい目標・計画を立てたいと言ったとき、" +
      "または集中して作業を進めているターンで進捗・状態が変わったとき。" +
      "雑談・単発の質問・感情・単なる記録/管理のときは起動しない。",
  ),
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runPlan(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
