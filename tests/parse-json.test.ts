import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  extractJsonText,
  parseJsonWithSchema,
  repairCommonJsonErrors,
  tryParseJsonWithSchema,
} from "../src/action/parse-json.js";
import { dreamDistillOutputSchema } from "../src/prompts/schemas.js";

const memoSchema = z.object({
  content: z.string(),
  filename: z.string().optional(),
});

describe("parseJsonWithSchema", () => {
  it("parses JSON inside markdown fence", () => {
    const raw = `\`\`\`json
{"content":"本文","filename":"a.md"}
\`\`\``;
    const result = parseJsonWithSchema(raw, memoSchema);
    expect(result).toEqual({ content: "本文", filename: "a.md" });
  });

  it("extractJsonText pulls object from prose", () => {
    const raw = '説明 {"content":"x"} 終わり';
    expect(extractJsonText(raw)).toBe('{"content":"x"}');
  });

  it("repairCommonJsonErrors fixes ,= in arrays", () => {
    const broken = '{"facts":[{"body":"x","tags":["態度",="信頼性"]}]}';
    const repaired = repairCommonJsonErrors(broken);
    const parsed = tryParseJsonWithSchema(repaired, dreamDistillOutputSchema);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.facts[0]!.tags).toEqual(["態度", "信頼性"]);
    }
  });
});
