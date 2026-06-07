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

  // 会話履歴はロールごとのターンではなくプレーンテキストとして渡す。
  // multi-turn 形式にすると judge LLM が assistant ロールを引き継ぎ
  // キャラクターとして返答しようとしてしまうため。
  const turns = buildConversationTurns(ctx);
  const lines = turns.map((t) =>
    t.role === "user" ? t.content : `自分: ${t.content}`,
  );

  const triggerLine =
    ctx.trigger.type === "user_message"
      ? `${ctx.dialogue.resolveUserDisplayName(ctx.trigger.speakerId)}: ${ctx.trigger.content}`
      : "（ハートビート）";

  const parts: string[] = [];
  if (lines.length > 0) {
    parts.push(`## 直近の会話\n${lines.join("\n")}`);
  }
  parts.push(`trigger: ${triggerLine}`);

  return [
    { role: "system", content: systemContent },
    { role: "user", content: parts.join("\n\n") },
  ];
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
