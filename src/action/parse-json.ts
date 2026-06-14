import type { z } from "zod";
import { truncateErrorDetail } from "./error.js";

/**
 * 推論モデル（qwen3 等）が think=false でも吐く `<think>…</think>` を除去する。
 * think ブロック内には例示の `{` `}` が混じるため、JSON 抽出の前に必ず落とす。
 * 閉じていない `<think>`（生成途中で切れた）も末尾まで落とす。
 */
export function stripThinkBlocks(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "");
}

/** LLM が ```json 付き・前置きの <think>・前後テキストで返したときなどを吸収する */
export function extractJsonText(raw: string): string {
  const trimmed = stripThinkBlocks(raw).trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) return fenced[1].trim();

  const inline = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (inline) return inline[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

/** LLM がよく壊す JSON 構文を軽く修復する */
export function repairCommonJsonErrors(text: string): string {
  return text
    .replace(/,\s*=/g, ", ")
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]");
}

/**
 * qwen が開いたオブジェクト（subagent の arguments 等）で引用符を過剰エスケープし
 * `{"query\":\"値\"}` のような不正 JSON を吐くことがある。`\"`→`"` で戻す。
 * 元が正しい JSON なら候補の先頭で通るので、これは壊れた時だけ効くフォールバック。
 */
export function deEscapeQuotes(text: string): string {
  return text.replace(/\\"/g, '"');
}

export type ParseJsonFailure = {
  reason: "empty" | "json_syntax" | "schema";
  rawPreview: string;
  zodMessage?: string;
};

export function tryParseJsonWithSchema<T>(
  raw: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; failure: ParseJsonFailure } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, failure: { reason: "empty", rawPreview: "" } };
  }

  const extracted = extractJsonText(raw);
  const candidates = [
    ...new Set([
      trimmed,
      extracted,
      repairCommonJsonErrors(trimmed),
      repairCommonJsonErrors(extracted),
      // 過剰エスケープ（`{"k\":\"v\"}`）の救済。元が正しければ上の候補で通るので最後に置く
      deEscapeQuotes(extracted),
      deEscapeQuotes(repairCommonJsonErrors(extracted)),
    ]),
  ].filter(Boolean);
  let lastSyntaxMessage: string | undefined;

  for (const text of candidates) {
    if (!text) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      const result = schema.safeParse(parsed);
      if (result.success) {
        return { ok: true, value: result.data };
      }
      return {
        ok: false,
        failure: {
          reason: "schema",
          rawPreview: truncateErrorDetail(text, 300),
          zodMessage: result.error.message,
        },
      };
    } catch (e) {
      lastSyntaxMessage = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    ok: false,
    failure: {
      reason: "json_syntax",
      rawPreview: truncateErrorDetail(extractJsonText(raw) || trimmed, 500),
      zodMessage: lastSyntaxMessage,
    },
  };
}

export function parseJsonWithSchema<T>(
  raw: string,
  schema: z.ZodType<T>,
): T | null {
  const result = tryParseJsonWithSchema(raw, schema);
  return result.ok ? result.value : null;
}
