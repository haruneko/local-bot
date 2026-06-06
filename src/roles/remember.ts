import { errorFromLlmAttempts } from "../action/error.js";
import {
  tryParseJsonWithSchema,
  type ParseJsonFailure,
} from "../action/parse-json.js";
import { actionFailed, actionSucceeded } from "../action/outcome.js";
import { lastUserMessageFromContext, type RunActionInput } from "../action/context.js";
import type { ActionOutcome } from "../types.js";
import { REMEMBER_SYSTEM } from "../prompts/roles.js";
import {
  rememberJsonSchema,
  rememberOutputSchema,
} from "../prompts/schemas.js";
import type { LlmClient } from "../llm/types.js";
import { formatActionMeta } from "../action/types.js";

export async function runRemember(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.ctx.judge!.ACTION;
  const lastUserMessage = lastUserMessageFromContext(input.ctx);
  const { turnId, state, currentDateTime } = input.ctx;
  const userLines = [
    `基準日時: ${currentDateTime}`,
    `意図: ${action.intent}`,
    lastUserMessage ? `直近のユーザー発話: ${lastUserMessage}` : "",
  ].filter(Boolean);

  const llmAttempts: string[] = [];
  let lastParseFailure: ParseJsonFailure | undefined;
  let body: string | null = null;
  const format = rememberJsonSchema as Record<string, unknown>;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: REMEMBER_SYSTEM },
        { role: "user", content: userLines.join("\n") },
      ],
      { format, temperature: 0 },
    );
    llmAttempts.push(raw);
    const parsed = tryParseJsonWithSchema(raw, rememberOutputSchema);
    if (parsed.ok && parsed.value.body.trim()) {
      body = parsed.value.body.trim();
      break;
    }
    if (!parsed.ok) {
      lastParseFailure = parsed.failure;
    }
  }

  if (!body) {
    return actionFailed(
      action,
      "覚える内容を生成できなかった",
      errorFromLlmAttempts(
        llmAttempts,
        lastParseFailure?.reason,
        lastParseFailure?.zodMessage,
      ),
    );
  }

  await input.episodes.append({
    body,
    metadata: {
      timestamp: new Date().toISOString(),
      participants: [],
      tags: [],
      state,
      action: formatActionMeta(action),
      source: "remember",
      reply: false,
      turnId: `${turnId}-remember`,
    },
  });

  return actionSucceeded(action, { kind: "remember", body });
}
