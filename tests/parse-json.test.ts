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

  it("過剰エスケープした subagent arguments を de-escape で救う", () => {
    // qwen が開いた arguments で吐く実際の壊れ方
    const broken =
      '{"done":false,"tool":"web_search","arguments":{"query\\":\\"ビットコイン 現在価格\\"}}';
    const schema = z.object({
      done: z.boolean(),
      tool: z.string().optional(),
      arguments: z.record(z.unknown()).optional(),
    });
    const parsed = tryParseJsonWithSchema(broken, schema);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.tool).toBe("web_search");
      expect(parsed.value.arguments).toEqual({ query: "ビットコイン 現在価格" });
    }
  });

  it("正しい JSON は de-escape の影響を受けない（値内の正規エスケープを壊さない）", () => {
    const valid = '{"speech":"彼は\\"やあ\\"と言った","nextState":"対話"}';
    const schema = z.object({ speech: z.string(), nextState: z.string() });
    const parsed = tryParseJsonWithSchema(valid, schema);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.speech).toBe('彼は"やあ"と言った');
  });
});
