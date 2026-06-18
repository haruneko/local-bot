import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runSynthesize } from "../roles/synthesize.js";

const SYNTHESIZE_ACTIVATE_PROMPT = [
  "会話を読み、成果物（歌詞・読書メモ・まとめ・文章など）を新しく作って書き残す必要があるかを判断してください。",
  "",
  '- 「書いて」「作って」「まとめて」と創作・要約をはっきり頼まれた → { "active": true, "intent": "..." }',
  '- 集中して取り組み中の成果物を一片進める → { "active": true, "intent": "..." }',
  '- 雑談・相槌・感情・単なる記録・質問への即答 → { "active": false }',
].join("\n");

export const synthesizeActor: ActorRunner = {
  name: "synthesize",
  activate: createActivate("synthesize", "", { systemPrompt: SYNTHESIZE_ACTIVATE_PROMPT }),
  run: (llm, input) => {
    const action = { kind: "memory" as const, intent: input.intent };
    return runSynthesize(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
