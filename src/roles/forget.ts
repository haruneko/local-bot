import { ACTION_ERROR_CODES } from "../action/error.js";
import { errorFromLlmAttempts } from "../action/error.js";
import {
  tryParseJsonWithSchema,
  type ParseJsonFailure,
} from "../action/parse-json.js";
import { actionFailed, actionSucceeded } from "../action/outcome.js";
import type { RunActionInput } from "../action/context.js";
import type { ActionOutcome } from "../types.js";
import { FORGET_PICK_SYSTEM } from "../prompts/roles.js";
import {
  forgetPickJsonSchema,
  forgetPickOutputSchema,
} from "../prompts/schemas.js";
import type { LlmClient } from "../llm/types.js";

export async function runForget(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.action;
  const query = action.intent.trim() || ".";
  const hits = await input.episodes.recall(query, input.episodeRecallTopK);

  if (hits.length === 0) {
    return actionSucceeded(
      action,
      "（該当する記憶は見つからなかった）",
    );
  }

  const candidates = hits.map((h, i) => ({
    id: i,
    turnId: h.turnId,
    body: h.body,
    distance: h.distance,
  }));

  const pickAttempts: string[] = [];
  let lastParseFailure: ParseJsonFailure | undefined;
  let turnId: string | null = null;
  let summary = "";
  const format = forgetPickJsonSchema as Record<string, unknown>;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: FORGET_PICK_SYSTEM },
        {
          role: "user",
          content: [
            `意図: ${action.intent}`,
            "",
            "記憶候補:",
            candidates
              .map(
                (c) =>
                  `[id=${c.id}] turnId=${c.turnId}\n${c.body.slice(0, 300)}`,
              )
              .join("\n\n"),
          ].join("\n"),
        },
      ],
      { format, temperature: 0 },
    );
    pickAttempts.push(raw);
    const parsed = tryParseJsonWithSchema(raw, forgetPickOutputSchema);
    if (!parsed.ok) {
      lastParseFailure = parsed.failure;
      continue;
    }
    if (!parsed.value.turnId) {
      return actionSucceeded(
        action,
        `意図に合う記憶が見つからなかった（候補 ${hits.length} 件）`,
      );
    }
    turnId = parsed.value.turnId;
    summary = parsed.value.summary.trim() || "記憶を忘れた";
    break;
  }

  if (!turnId) {
    return actionFailed(
      action,
      "忘れる記憶を選べなかった",
      errorFromLlmAttempts(
        pickAttempts,
        lastParseFailure?.reason,
        lastParseFailure?.zodMessage,
      ),
    );
  }

  const validIds = new Set(candidates.map((c) => c.turnId));
  if (!validIds.has(turnId)) {
    return actionFailed(action, "選んだ記憶が候補にない", {
      code: ACTION_ERROR_CODES.PICK_FAILED,
      message: `LLMが選んだ turnId ${turnId} は候補にない`,
      detail: `候補: ${[...validIds].join(", ")}`,
    });
  }

  const deleted = await input.episodes.softDelete(turnId);
  if (!deleted) {
    return actionFailed(action, "記憶の削除に失敗した", {
      code: ACTION_ERROR_CODES.TOOL_FAILED,
      message: `turnId ${turnId} のソフト削除に失敗`,
    });
  }
  // 横断ベクトルも一緒に消す（あれば）。横断オフ/該当なしなら no-op。
  await input.xmodal?.remove(turnId);

  return actionSucceeded(action, { kind: "forget", body: summary });
}
