import { JUDGE_SYSTEM } from "../prompts/roles.js";
import { judgeJsonSchema } from "../judge/schema.js";
import { defaultJudgeFallback, parseJudgeJson } from "../judge/parse.js";
import {
  buildConversationTurns,
  buildJudgeContextSuffix,
  type TurnContext,
} from "../context/turn-context.js";
import type { ChatMessage, LlmClient } from "../llm/types.js";
import type { JudgeOutput } from "../types.js";

function buildJudgeMessages(ctx: TurnContext): ChatMessage[] {
  const systemContent = JUDGE_SYSTEM + buildJudgeContextSuffix(ctx);
  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...buildConversationTurns(ctx),
  ];
  if (ctx.trigger.type === "user_message") {
    const name = ctx.dialogue.resolveUserDisplayName(ctx.trigger.speakerId);
    messages.push({ role: "user", content: `${name}: ${ctx.trigger.content}` });
  } else {
    messages.push({ role: "user", content: "（ハートビート）" });
  }
  return messages;
}

export async function runJudge(
  llm: LlmClient,
  ctx: TurnContext,
): Promise<JudgeOutput> {
  const format = judgeJsonSchema as Record<string, unknown>;
  const messages = buildJudgeMessages(ctx);

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(messages, { format, temperature: 0 });
    const parsed = parseJudgeJson(raw, ctx.state);
    if (parsed.ok) return parsed.value;
    if (attempt === 1) {
      console.warn("[judge] parse failed, using fallback", parsed.raw);
      return parsed.fallback;
    }
  }

  return defaultJudgeFallback(ctx.state);
}
