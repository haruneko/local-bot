import { describe, expect, it } from "vitest";
import { parseJudgeJson } from "../src/judge/parse.js";
import { NONE_ACTION } from "../src/action/types.js";

describe("parseJudgeJson", () => {
  it("T-J01: parses valid judge JSON with none action", () => {
    const raw = JSON.stringify({
      ACTION: { kind: "none", intent: "" },
      REPLY: true,
      NEXT_STATE: "静穏",
    });
    const result = parseJudgeJson(raw, "対話");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        ACTION: NONE_ACTION,
        REPLY: true,
        NEXT_STATE: "静穏",
      });
    }
  });

  it("T-J01b: normalizes legacy ACTION null to none", () => {
    const raw = JSON.stringify({
      ACTION: null,
      REPLY: false,
      NEXT_STATE: "対話",
    });
    const result = parseJudgeJson(raw, "静穏");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ACTION).toEqual(NONE_ACTION);
    }
  });

  it("T-J01c: parses memory action", () => {
    const raw = JSON.stringify({
      ACTION: { kind: "memory", intent: "買い物リストをメモに書く" },
      REPLY: true,
      NEXT_STATE: "対話",
    });
    const result = parseJudgeJson(raw, "対話");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ACTION).toEqual({
        kind: "memory",
        intent: "買い物リストをメモに書く",
      });
    }
  });

  it("T-J02: falls back on invalid JSON", () => {
    const result = parseJudgeJson("not json", "対話");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toEqual({
        ACTION: NONE_ACTION,
        REPLY: true,
        NEXT_STATE: "対話",
      });
    }
  });
});
