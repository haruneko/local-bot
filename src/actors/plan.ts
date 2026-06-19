import type { ActorRunner } from "./types.js";
import { runPlan } from "../roles/plan.js";

export const planActor: ActorRunner = {
  name: "plan",
  // 起動判定は multi-label（1発）が criteria を見て決める。
  criteria:
    "計画そのものを管理したいとき＝目標を新しく立てる／既存の計画を始める・再開する・棚上げする・見限る／手で修正する。" +
    "相手がそう望んだときに加え、あなた自身が独り言で「あれを再開しよう」「後のために予定を足そう」と思ったときも含む。" +
    "日々のマイルストーンの前進・✓は別の仕組みが自動でやるのでここでは不要。" +
    "単発の質問・雑談・感情・単純な記録（足す/消す/確認だけ＝memo の領分）では起動しない。",
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runPlan(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
