import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runSynthesize } from "../roles/synthesize.js";

export const synthesizeActor: ActorRunner = {
  name: "synthesize",
  activate: createActivate(
    "synthesize",
    "想起した記憶・外部情報・いまの感性を統合して、成果物（歌詞・読書メモ・まとめ・文章など）を新しく作って書き残す。" +
      "決まったことの転記（memo）ではなく、自分の言葉でまとめる/創る行為。起動するのは次だけ: " +
      "(1) 相手が「書いて」「作って」「まとめて」と創作・要約を明示的に求めた、" +
      "(2) 集中して取り組み中の成果物を一片進めるとき。" +
      "雑談・相槌・感情・単なる記録・質問への即答では起動しない。",
  ),
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runSynthesize(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
