import type { ActorRunner } from "./types.js";
import { runSynthesize } from "../roles/synthesize.js";

export const synthesizeActor: ActorRunner = {
  name: "synthesize",
  // 起動判定は multi-label（1発）が criteria を見て決める。
  criteria:
    "成果物（歌詞・読書メモ・まとめ・文章など）を新しく作って書き残すとき。" +
    "「書いて／作って／まとめて」と創作・要約を頼まれた・集中で取り組み中の成果物を一片進める、のとき。" +
    "雑談・相槌・感情・単なる記録（転記は memo）・質問への即答では起動しない。",
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runSynthesize(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
