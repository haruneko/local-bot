import { describe, expect, it } from "vitest";
import { z } from "zod";
import { actionFailed } from "../src/action/outcome.js";
import { ACTION_ERROR_CODES } from "../src/action/error.js";
import { errorFromLlmAttempts } from "../src/action/error.js";
import { tryParseJsonWithSchema } from "../src/action/parse-json.js";

describe("action errors", () => {
  it("actionFailed embeds code and detail in summary", () => {
    const outcome = actionFailed(
      { kind: "memory", intent: "test" },
      "メモの内容を決められなかった",
      {
        code: ACTION_ERROR_CODES.LLM_PARSE,
        message: "JSONとして解釈できなかった",
        detail: "--- LLM応答 1 ---\n```json",
      },
    );
    if (!outcome.attempted) throw new Error("expected attempted");
    expect(outcome.summary).toContain("原因コード: llm_parse_failed");
    expect(outcome.summary).toContain("詳細:");
    expect(outcome.error?.code).toBe("llm_parse_failed");
  });

  it("tryParseJsonWithSchema reports schema failure", () => {
    const raw = '{"content":""}';
    const result = tryParseJsonWithSchema(
      raw,
      z.object({ content: z.string().min(1) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe("schema");
    }
  });

  it("errorFromLlmAttempts includes all attempts", () => {
    const err = errorFromLlmAttempts(["not json", '{"x":1}'], "json_syntax");
    expect(err.detail).toContain("LLM応答 1");
    expect(err.detail).toContain("LLM応答 2");
  });
});
