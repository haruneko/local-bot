import { JUDGE_SYSTEM } from "../prompts/roles.js";
import { judgeJsonSchema } from "../judge/schema.js";
import { defaultJudgeFallback, parseJudgeJson } from "../judge/parse.js";
import { renderJudgeUserPayload, type TurnContext } from "../context/turn-context.js";
import type { LlmClient } from "../llm/types.js";
import type { JudgeOutput } from "../types.js";

export async function runJudge(
  llm: LlmClient,
  ctx: TurnContext,
): Promise<JudgeOutput> {
  const format = judgeJsonSchema as Record<string, unknown>;
  const userContent = renderJudgeUserPayload(ctx);

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: userContent },
      ],
      { format, temperature: 0 },
    );
    const parsed = parseJudgeJson(raw, ctx.state);
    if (parsed.ok) return parsed.value;
    if (attempt === 1) {
      console.warn("[judge] parse failed, using fallback", parsed.raw);
      return parsed.fallback;
    }
  }

  return defaultJudgeFallback(ctx.state);
}
