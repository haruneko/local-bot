import { describe, expect, it } from "vitest";
import {
  JUDGE_SYSTEM,
  LANGUAGE_HEARTBEAT_SYSTEM_PREFIX,
  LANGUAGE_SYSTEM_PREFIX,
  REMEMBER_SYSTEM,
} from "../../src/prompts/roles.js";
import { formatActionForLanguage } from "../../src/action/present.js";

describe("role prompts", () => {
  it("LANGUAGE_SYSTEM_PREFIX does not leak module identity phrasing", () => {
    expect(LANGUAGE_SYSTEM_PREFIX).not.toContain("言語化するモジュール");
    expect(LANGUAGE_SYSTEM_PREFIX).not.toContain("あなたは言語化");
    expect(LANGUAGE_SYSTEM_PREFIX).not.toMatch(/あなたは.*担当/);
  });

  it("JUDGE_SYSTEM lists all five ACTION kinds", () => {
    for (const kind of [
      "none",
      "remember",
      "recall",
      "memo_write",
      "memo_read",
    ]) {
      expect(JUDGE_SYSTEM).toContain(kind);
    }
  });

  it("JUDGE_SYSTEM guides user_message REPLY and known NEXT_STATE", () => {
    expect(JUDGE_SYSTEM).toContain("user_message");
    expect(JUDGE_SYSTEM).toContain("「対話」");
    expect(JUDGE_SYSTEM).toContain("「静穏」");
  });

  it("LANGUAGE_HEARTBEAT_SYSTEM_PREFIX uses positive templates", () => {
    expect(LANGUAGE_HEARTBEAT_SYSTEM_PREFIX).toContain("独り言の型");
    expect(LANGUAGE_HEARTBEAT_SYSTEM_PREFIX).toContain("良い例:");
    expect(LANGUAGE_HEARTBEAT_SYSTEM_PREFIX).not.toContain("質問で返さない");
  });

  it("REMEMBER_SYSTEM normalizes relative dates to absolute", () => {
    expect(REMEMBER_SYSTEM).toContain("基準日時");
    expect(REMEMBER_SYSTEM).toContain("今日");
    expect(REMEMBER_SYSTEM).toContain("年月日");
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
