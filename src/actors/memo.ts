import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runMemo } from "../roles/memo.js";

export const memoActor: ActorRunner = {
  name: "memo",
  activate: createActivate(
    "memo",
    "メモファイル（data/notes/）を読み書きする。読み（参照・読み上げ）と書き（記録・追記・推敲）の両方を担う。" +
      "起動するのは、相手がメモの参照・記録・修正を求めたとき、" +
      "後で確実に参照したい新しい具体情報（決定・約束・成果物・素材）が生まれたとき、" +
      "または集中して作業を進めるターンで成果物を書き進めるとき。" +
      "雑談・単発の質問・感情のやり取りだけのときは起動しない（勝手にメモを増やさない）。",
  ),
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runMemo(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
