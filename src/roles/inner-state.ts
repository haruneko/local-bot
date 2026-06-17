import {
  formatActionForLanguage,
  silenceLine,
} from "../action/present.js";
import { AFFECT_CONCERN_SYSTEM } from "../prompts/roles.js";
import type { ChatMessage, LlmClient } from "../llm/types.js";
import type { ActionOutcome } from "../types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { tryParseJsonWithSchema } from "../action/parse-json.js";

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
  /** このターンの記憶の残りやすさ（1-10）。いま生成した affect の動きを根拠に採点する＝
   *  情動的顕著性で符号化強度を決める。内省ではなくここで付ける（DECISIONS §内省の見える範囲） */
  importance: number;
};

const DEFAULT_IMPORTANCE = 5;

const affectConcernSchema = z.object({
  affect: z.string(),
  concern: z.string(),
  importance: z.number().int().min(1).max(10),
});

const affectConcernJsonSchema = zodToJsonSchema(affectConcernSchema, {
  name: "AffectConcern",
  $refStrategy: "none",
}) as Record<string, unknown>;

/** 内心テキストの最初の1文（句点区切り）。焼き直し防止のため圧縮して渡す */
function firstSentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const idx = t.indexOf("。");
  if (idx >= 0) return t.slice(0, idx + 1);
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

/** このターンの自分の動き（内省・行動・発話）を 1 つの assistant メッセージにまとめる。
 *  すべて自分のものなので role:assistant で渡し、自他境界を構造で示す。 */
function buildSelfMessage(input: UpdateAffectAndConcernInput): string {
  const speechBlock = input.speech?.trim() ? input.speech : silenceLine();
  const parts: string[] = [];

  const attempted = input.actions.filter(
    (a): a is Extract<ActionOutcome, { attempted: true }> => a.attempted,
  );
  for (const action of attempted) {
    parts.push(formatActionForLanguage(action));
  }

  parts.push("（内省）", input.introspection.trim(), "（いま自分が言ったこと）", speechBlock);
  return parts.join("\n");
}

/** 前の内心・関心事と指示を user メッセージにまとめる。 */
function buildInstruction(input: UpdateAffectAndConcernInput): string {
  const prevAffect = firstSentence(input.prevAffect) || "（まだない）";
  const prevConcern = input.prevConcern.trim() || "（まだない）";

  return [
    `（日時: ${input.currentDateTime}）`,
    "",
    "【前の内心（affect/要約1文）】",
    prevAffect,
    "",
    "【前の関心事（concern/1文）】",
    prevConcern,
    "",
    "上はあなた自身のこのターンの振り返り。これと前の内心を踏まえ、いまの内心と関心事を書いて。",
  ].join("\n");
}

function clampImportance(n: unknown): number {
  if (typeof n !== "number" || Number.isNaN(n)) return DEFAULT_IMPORTANCE;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function parseAffectAndConcern(raw: string): AffectAndConcern {
  const strict = tryParseJsonWithSchema(raw, affectConcernSchema);
  if (strict.ok) {
    return { ...strict.value, importance: clampImportance(strict.value.importance) };
  }
  // フォールバック: importance 欠落・型ズレでも affect/concern は拾う
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<AffectAndConcern>;
    return {
      affect: typeof parsed.affect === "string" ? parsed.affect : "",
      concern: typeof parsed.concern === "string" ? parsed.concern : "",
      importance: clampImportance(parsed.importance),
    };
  } catch {
    return { affect: raw.trim(), concern: "", importance: DEFAULT_IMPORTANCE };
  }
}

export async function updateAffectAndConcern(
  llm: LlmClient,
  input: UpdateAffectAndConcernInput,
): Promise<AffectAndConcern> {
  const messages: ChatMessage[] = [
    { role: "system", content: AFFECT_CONCERN_SYSTEM },
    { role: "assistant", content: buildSelfMessage(input) },
    { role: "user", content: buildInstruction(input) },
  ];
  const raw = await llm.chat(messages, {
    format: affectConcernJsonSchema,
    temperature: 0.6,
  });
  return parseAffectAndConcern(raw);
}
