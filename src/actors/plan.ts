import type { ActorRunner } from "./types.js";
import { runPlan } from "../roles/plan.js";

export const planActor: ActorRunner = {
  name: "plan",
  // 起動判定は multi-label（1発）が criteria を見て決める。
  criteria:
    "段階を踏んで進める目標（学習・制作・調査など複数ステップ）を相手が立てたい／更新したいとき、" +
    "または集中作業で進捗・状態が変わったとき。単発の質問・雑談・感情・単純な記録（足す/消す/確認だけ＝memo の領分）では起動しない。",
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runPlan(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
