import {
  renderIntrospectionPrompt,
  type TurnContext,
} from "../context/turn-context.js";
import { INTROSPECTION_SYSTEM } from "../prompts/roles.js";
import type { LlmClient } from "../llm/types.js";

export async function runIntrospection(
  llm: LlmClient,
  ctx: TurnContext,
): Promise<string> {
  const prompt = renderIntrospectionPrompt(ctx);
  return llm.chat(
    [
      { role: "system", content: INTROSPECTION_SYSTEM },
      { role: "user", content: prompt },
    ],
    { temperature: 0.6 },
  );
}
