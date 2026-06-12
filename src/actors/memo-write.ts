import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runMemoWrite } from "../roles/memo-write.js";

export const memoWriteActor: ActorRunner = {
  name: "memoWrite",
  activate: createActivate(
    "memoWrite",
    "メモファイル（data/notes/）に書き残す。" +
      "起動するのは、相手の明示的な依頼（「メモして」「書いておいて」「残して」等）があるとき、" +
      "または後で確実に参照したい新しい具体情報（決定・約束・成果物・素材）が生まれたときだけ。" +
      "質問への返答・感想・雑談・感情のやり取りだけのときは起動しない（勝手にメモを増やさない）",
  ),
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runMemoWrite(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
