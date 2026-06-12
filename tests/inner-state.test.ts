import { describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/llm/fake.js";
import { updateAffectAndConcern } from "../src/roles/inner-state.js";

describe("updateAffectAndConcern (T-IS01, T-IS02)", () => {
  it("T-IS01: returns {affect, concern} parsed from LLM JSON output", async () => {
    const llm = new FakeLlmClient([
      '{"affect":"ちょっと恥ずかしいな","concern":"記憶アーキテクチャの実装方法"}',
    ]);
    const result = await updateAffectAndConcern(llm, {
      prevAffect: "",
      prevConcern: "",
      introspection: "同じことを二度言ってしまった",
      speech: "ごめんね",
      actions: [],
      currentDateTime: "2026-06-10 10:00",
    });

    expect(result.affect).toBe("ちょっと恥ずかしいな");
    expect(result.concern).toBe("記憶アーキテクチャの実装方法");
    expect(llm.calls).toHaveLength(1);
  });

  it("T-IS01: returns empty strings when LLM returns empty values", async () => {
    const llm = new FakeLlmClient(['{"affect":"","concern":""}']);
    const result = await updateAffectAndConcern(llm, {
      prevAffect: "",
      prevConcern: "",
      introspection: "特に何もなかった",
      speech: null,
      actions: [],
      currentDateTime: "2026-06-10 10:00",
    });

    expect(result.affect).toBe("");
    expect(result.concern).toBe("");
  });

  it("T-IS02: 自分の内省は assistant、前の内心/関心事は user メッセージに入る", async () => {
    const llm = new FakeLlmClient([
      '{"affect":"謝って落ち着いた","concern":"記憶実装の具体例"}',
    ]);
    await updateAffectAndConcern(llm, {
      prevAffect: "恥ずかしかった",
      prevConcern: "記憶アーキテクチャの実装方法",
      introspection: "謝ったら少し楽になった",
      speech: null,
      actions: [],
      currentDateTime: "2026-06-10 10:05",
    });

    const msgs = llm.calls[0]!.messages;
    const self = msgs.find((m) => m.role === "assistant")!.content;
    const user = msgs.find((m) => m.role === "user")!.content;
    // 自分のこのターンの振り返り（内省）は自分=assistant 側
    expect(self).toContain("謝ったら少し楽になった");
    // 前の内心・関心事は指示=user 側
    expect(user).toContain("恥ずかしかった");
    expect(user).toContain("記憶アーキテクチャの実装方法");
  });

  it("T-IS02: prevAffect and prevConcern show placeholder when empty", async () => {
    const llm = new FakeLlmClient(['{"affect":"初めての感想","concern":""}']);
    await updateAffectAndConcern(llm, {
      prevAffect: "",
      prevConcern: "",
      introspection: "初めて話した",
      speech: "はじめまして",
      actions: [],
      currentDateTime: "2026-06-10 10:00",
    });

    const user = llm.calls[0]!.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("（まだない）");
  });
});
