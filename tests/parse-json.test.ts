import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJsonText, parseJsonWithSchema } from "../src/action/parse-json.js";

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
});
