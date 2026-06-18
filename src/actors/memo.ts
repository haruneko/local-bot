import type { ActorRunner } from "./types.js";
import { runMemo } from "../roles/memo.js";

export const memoActor: ActorRunner = {
  name: "memo",
  // 起動判定は multi-label（1発）が criteria を見て決める。
  criteria:
    "おぼろげな記憶でなく、書き変わらない確かな情報を外部メモ（notes）に書き残す／読み出す。" +
    "「メモして／覚えておいて／あれ見て」と頼まれた・後で正確に参照したい具体物（決定/約束/リスト/素材）が生まれた・" +
    "過去に同じことを記録していないか確認したい・集中で取り組み中の成果物を書き進める、のとき。雑談・相槌・感情では起動しない。",
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runMemo(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
