import { ACTION_ERROR_CODES } from "../action/error.js";
import { errorFromLlmAttempts } from "../action/error.js";
import {
  tryParseJsonWithSchema,
  type ParseJsonFailure,
} from "../action/parse-json.js";
import { actionFailed, actionSucceeded } from "../action/outcome.js";
import { lastUserMessageFromContext, type RunActionInput } from "../action/context.js";
import type { ActionOutcome } from "../types.js";
import { MEMO_WRITE_SYSTEM } from "../prompts/roles.js";
import {
  memoWriteJsonSchema,
  memoWriteOutputSchema,
} from "../prompts/schemas.js";
import type { LlmClient } from "../llm/types.js";
import { executeTool } from "../tools/registry.js";
import { listNotesSummary } from "../tools/registry.js";
import { normalizeWriteArgs } from "../tools/notes.js";

export async function runMemoWrite(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.action;
  const lastUserMessage = lastUserMessageFromContext(input.ctx);
  const existingNotes = await listNotesSummary();

  const llmAttempts: string[] = [];
  let lastParseFailure: ParseJsonFailure | undefined;

  let choice: { content: string; filename?: string } | null = null;
  const format = memoWriteJsonSchema as Record<string, unknown>;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: MEMO_WRITE_SYSTEM },
        {
          role: "user",
          content: [
            `意図: ${action.intent}`,
            lastUserMessage ? `直近のユーザー発話: ${lastUserMessage}` : "",
            "",
            "既存メモ:",
            existingNotes,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      { format, temperature: 0 },
    );
    llmAttempts.push(raw);
    const parsed = tryParseJsonWithSchema(raw, memoWriteOutputSchema);
    if (parsed.ok) {
      choice = parsed.value;
      break;
    }
    lastParseFailure = parsed.failure;
  }

  if (!choice) {
    return actionFailed(
      action,
      "メモの内容を決められなかった",
      errorFromLlmAttempts(
        llmAttempts,
        lastParseFailure?.reason,
        lastParseFailure?.zodMessage,
      ),
    );
  }

  const args = normalizeWriteArgs(
    {
      content: choice.content,
      filename: choice.filename,
    },
    lastUserMessage,
  );
  if (!args) {
    return actionFailed(action, "メモの引数が不正だった", {
      code: ACTION_ERROR_CODES.INVALID_ARGS,
      message: "content が空、または filename が安全でない",
      detail: JSON.stringify({
        contentLength: choice.content.length,
        filename: choice.filename ?? null,
      }),
    });
  }

  const result = await executeTool({
    name: "write_note",
    arguments: args,
  });
  if (!result.ok) {
    return actionFailed(action, "メモファイルへの書き込みに失敗した", {
      code: ACTION_ERROR_CODES.TOOL_FAILED,
      message: result.summary,
    });
  }

  const now = new Date().toISOString();
  await input.memoIndex?.upsert({
    path: args.filename,
    preview: args.content.slice(0, 200),
    createdAt: now,
    updatedAt: now,
  });

  return actionSucceeded(action, {
    kind: "memo_write",
    filename: args.filename,
    body: args.content,
  });
}
