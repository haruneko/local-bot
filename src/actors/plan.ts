import type { ActorRunner } from "./types.js";
import { runPlan } from "../roles/plan.js";

export const planActor: ActorRunner = {
  name: "plan",
  // 起動判定は multi-label（1発）が criteria を見て決める。
  criteria:
    "複数ステップで取り組む目標・計画（学習・制作・調査・実装・改善など）が話題になった／立てたい／思い出した／" +
    "始める・再開・棚上げ・見限り・手で修正したいとき。**新しい多段トピックは『積むだけ』(activate:false)でも捕捉する**" +
    "（後で思い出して再開できるように）。相手が望んだときに加え、自分の独り言（あれ再開しよう・予定足そう）も含む。" +
    "**多段で取り組む「目標そのもの」は plan の領分**（単発の事実・在庫・リスト・素材の記録は memo）。" +
    "日々のマイルストーン✓は自動なので不要。単発の質問・雑談・感情では起動しない。",
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runPlan(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
