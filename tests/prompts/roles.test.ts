import { describe, expect, it } from "vitest";
import {
  LANGUAGE_HEARTBEAT_SYSTEM_PREFIX,
  LANGUAGE_SYSTEM_PREFIX,
} from "../../src/prompts/roles.js";
import { formatActionForLanguage } from "../../src/action/present.js";

describe("role prompts", () => {
  it("LANGUAGE_SYSTEM_PREFIX does not leak module identity phrasing", () => {
    expect(LANGUAGE_SYSTEM_PREFIX).not.toContain("言語化するモジュール");
    expect(LANGUAGE_SYSTEM_PREFIX).not.toContain("あなたは言語化");
    expect(LANGUAGE_SYSTEM_PREFIX).not.toMatch(/あなたは.*担当/);
  });

  it("LANGUAGE_HEARTBEAT_SYSTEM_PREFIX shows a positive example without prohibition framing", () => {
    expect(LANGUAGE_HEARTBEAT_SYSTEM_PREFIX).toContain("例:");
    expect(LANGUAGE_HEARTBEAT_SYSTEM_PREFIX).not.toContain("悪い例");
    expect(LANGUAGE_HEARTBEAT_SYSTEM_PREFIX).not.toContain("質問で返さない");
  });

});

describe("formatActionForLanguage regression", () => {
  it("does not include first-person pronouns in action facts", () => {
    const text = formatActionForLanguage({
      attempted: true,
      kind: "remember",
      intent: "好み",
      status: "succeeded",
      facts: { kind: "remember", body: "コーヒーが好き" },
      summary: "LanceDB（source: remember）に記録した: コーヒーが好き",
    });
    expect(text).toContain("コーヒーが好き");
    expect(text).not.toMatch(/わたし|私は/);
  });
});
