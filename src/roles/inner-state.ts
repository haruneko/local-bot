import {
  formatActionForIntrospection,
  silenceLine,
} from "../action/present.js";
import { actionLabelJa } from "../action/types.js";
import { INNER_STATE_SYSTEM } from "../prompts/roles.js";
import type { LlmClient } from "../llm/types.js";
import type { ActionOutcome } from "../types.js";

export type UpdateInnerStateInput = {
  prevInnerState: string;
  introspection: string;
  speech: string | null;
  action: ActionOutcome;
  currentDateTime: string;
};

function buildInnerStateUserContent(input: UpdateInnerStateInput): string {
  const speechBlock = input.speech?.trim()
    ? input.speech
    : silenceLine();

  const parts = [
    `（日時: ${input.currentDateTime}）`,
    "",
    "【前の内心】",
    input.prevInnerState.trim() || "（まだない）",
    "",
    "【このターンの内省】",
    input.introspection.trim(),
    "",
    "【いま自分が言ったこと】",
    speechBlock,
  ];

  if (input.action.attempted) {
    const label = actionLabelJa(input.action.kind);
    parts.push(
      "",
      "【行動】",
      `やろうとしたこと: ${label} — ${input.action.intent}`,
      formatActionForIntrospection(input.action),
    );
  }

  return parts.join("\n");
}

export async function updateInnerState(
  llm: LlmClient,
  input: UpdateInnerStateInput,
): Promise<string> {
  return llm.chat(
    [
      { role: "system", content: INNER_STATE_SYSTEM },
      { role: "user", content: buildInnerStateUserContent(input) },
    ],
    { temperature: 0.6 },
  );
}
