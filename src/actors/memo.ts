import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runMemo } from "../roles/memo.js";

export const memoActor: ActorRunner = {
  name: "memo",
  activate: createActivate(
    "memo",
    "メモファイル（data/notes/）＝外部ノートを正確に読み書きする（ふつうの記憶ではない・勝手にメモを増やさない）。起動するのは次だけ: " +
      "(1) 相手が明示的に参照・記録・修正を求めた（「メモして」「あれ見て」等）、" +
      "(2) 後で正確に参照したい具体物が生まれた（決定・約束・リスト・成果物・素材）、" +
      "(3) 集中作業で成果物を書き進める。" +
      "雑談・相槌・感情・お礼・「なんとなく覚えておく」程度では起動しない。",
  ),
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runMemo(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
