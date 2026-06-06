import { ACTION_ERROR_CODES } from "../action/error.js";
import { errorFromLlmAttempts } from "../action/error.js";
import {
  tryParseJsonWithSchema,
  type ParseJsonFailure,
} from "../action/parse-json.js";
import { actionFailed, actionSucceeded } from "../action/outcome.js";
import type { RunActionInput } from "../action/context.js";
import type { ActionOutcome } from "../types.js";
import { MEMO_READ_PICK_SYSTEM } from "../prompts/roles.js";
import {
  memoReadPickJsonSchema,
  memoReadPickOutputSchema,
} from "../prompts/schemas.js";
import type { LlmClient } from "../llm/types.js";
import {
  formatNotePreviewIndex,
  listNotePreviews,
  readNoteContent,
} from "../tools/notes.js";

export async function runMemoRead(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.ctx.judge!.ACTION;
  const previews = await listNotePreviews();
  const files = previews.map((p) => p.filename);

  if (files.length === 0) {
    return actionFailed(action, "読むメモがない", {
      code: ACTION_ERROR_CODES.NO_MEMO_FILES,
      message: "data/notes にファイルが1つもない",
    });
  }

  const pickAttempts: string[] = [];
  let lastParseFailure: ParseJsonFailure | undefined;
  let filename: string | null = null;
  const format = memoReadPickJsonSchema as Record<string, unknown>;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: MEMO_READ_PICK_SYSTEM },
        {
          role: "user",
          content: [
            `意図: ${action.intent}`,
            "",
            "メモ一覧（ファイル名 — 冒頭抜粋）:",
            formatNotePreviewIndex(previews),
          ].join("\n"),
        },
      ],
      { format, temperature: 0 },
    );
    pickAttempts.push(raw);
    const parsed = tryParseJsonWithSchema(raw, memoReadPickOutputSchema);
    if (!parsed.ok) {
      lastParseFailure = parsed.failure;
      continue;
    }
    if (parsed.value.filename) {
      filename = parsed.value.filename;
      break;
    }
    return actionSucceeded(
      action,
      `意図に合うメモが見つからなかった（一覧: ${files.join(", ")}）`,
    );
  }

  if (!filename) {
    return actionFailed(
      action,
      "読むメモを選べなかった",
      errorFromLlmAttempts(
        pickAttempts,
        lastParseFailure?.reason,
        lastParseFailure?.zodMessage,
      ),
    );
  }

  if (!files.includes(filename)) {
    return actionFailed(action, "選んだメモが一覧にない", {
      code: ACTION_ERROR_CODES.PICK_FAILED,
      message: `LLMが選んだ ${filename} は存在しない`,
      detail: `一覧: ${files.join(", ")}`,
    });
  }

  const text = await readNoteContent(filename);
  if (text === null) {
    return actionFailed(action, `メモ ${filename} を開けなかった`, {
      code: ACTION_ERROR_CODES.FILE_NOT_FOUND,
      message: "readNoteContent が null を返した（パス安全処理後）",
      detail: `filename: ${filename}`,
    });
  }

  return actionSucceeded(action, {
    kind: "memo_read",
    filename,
    body: text,
  });
}
