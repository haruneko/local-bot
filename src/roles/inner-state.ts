import {
  formatActionForIntrospection,
  silenceLine,
} from "../action/present.js";
import { actionLabelJa } from "../action/types.js";
import { AFFECT_CONCERN_SYSTEM } from "../prompts/roles.js";
import type { LlmClient } from "../llm/types.js";
import type { ActionOutcome } from "../types.js";

export type UpdateAffectAndConcernInput = {
  prevAffect: string;
  prevConcern: string;
  introspection: string;
  speech: string | null;
  actions: ActionOutcome[];
  currentDateTime: string;
};

export type AffectAndConcern = {
  affect: string;
  concern: string;
};

/** 内心テキストの最初の1文（句点区切り）。焼き直し防止のため圧縮して渡す */
function firstSentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const idx = t.indexOf("。");
  if (idx >= 0) return t.slice(0, idx + 1);
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

function buildUserContent(input: UpdateAffectAndConcernInput): string {
  const speechBlock = input.speech?.trim() ? input.speech : silenceLine();

  const prevAffect = firstSentence(input.prevAffect) || "（まだない）";
  const prevConcern = input.prevConcern.trim() || "（まだない）";

  const parts = [
    `（日時: ${input.currentDateTime}）`,
    "",
    "【前の内心（affect/要約1文）】",
    prevAffect,
    "",
    "【前の関心事（concern/1文）】",
    prevConcern,
    "",
    "【このターンの内省】",
    input.introspection.trim(),
    "",
    "【いま自分が言ったこと】",
    speechBlock,
  ];

  const attempted = input.actions.filter(
    (a): a is Extract<ActionOutcome, { attempted: true }> => a.attempted,
  );
  if (attempted.length > 0) {
    parts.push("", "【行動】");
    for (const action of attempted) {
      const label = actionLabelJa(action.kind);
      parts.push(
        `やろうとしたこと: ${label} — ${action.intent}`,
        formatActionForIntrospection(action),
      );
    }
  }

  return parts.join("\n");
}

function parseAffectAndConcern(raw: string): AffectAndConcern {
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<AffectAndConcern>;
    return {
      affect: typeof parsed.affect === "string" ? parsed.affect : "",
      concern: typeof parsed.concern === "string" ? parsed.concern : "",
    };
  } catch {
    return { affect: raw.trim(), concern: "" };
  }
}

export async function updateAffectAndConcern(
  llm: LlmClient,
  input: UpdateAffectAndConcernInput,
): Promise<AffectAndConcern> {
  const raw = await llm.chat(
    [
      { role: "system", content: AFFECT_CONCERN_SYSTEM },
      { role: "user", content: buildUserContent(input) },
    ],
    { temperature: 0.6 },
  );
  return parseAffectAndConcern(raw);
}
