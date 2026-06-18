import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runMemo } from "../roles/memo.js";

const MEMO_ACTIVATE_PROMPT = [
  "会話を読み、おぼろげな記憶ではなく、書き変わらない確かな情報として外部メモに書き残す／読み出す必要があるかを判断してください。",
  "",
  '- 「メモして」「覚えておいて」「あれ見て」など記録・参照をはっきり頼まれた → { "active": true, "intent": "具体的な意図" }',
  '- 後で正確に参照したい具体物（決定・約束・リスト・素材）が生まれた → { "active": true, "intent": "..." }',
  '- 過去に同じことを記録していないか確認したい → { "active": true, "intent": "..." }',
  '- 集中して取り組み中の成果物を書き進める → { "active": true, "intent": "..." }',
  '- どれも不要 → { "active": false }',
].join("\n");

export const memoActor: ActorRunner = {
  name: "memo",
  activate: createActivate("memo", "", { systemPrompt: MEMO_ACTIVATE_PROMPT }),
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runMemo(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
