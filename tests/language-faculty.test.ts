import { describe, expect, it } from "vitest";
import { generateDialogueSpeech } from "../src/roles/language-faculty.js";
import { createTurnContext, withPersona } from "../src/context/turn-context.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { LANGUAGE_HEARTBEAT_SYSTEM_PREFIX, LANGUAGE_SYSTEM_PREFIX } from "../src/prompts/roles.js";

const dialogue = { resolveUserDisplayName: (id: string) => id === "u1" ? "HAL" : id };

function makeHeartbeatCtx(priorTurns: Parameters<typeof createTurnContext>[0]["recentTurns"] = []) {
  return withPersona(
    createTurnContext({
      turnId: "t-hb",
      state: "静穏",
      trigger: { type: "heartbeat" },
      dialogue,
      recentTurns: priorTurns,
      recalledEpisodes: [],
    }),
    "キャラクター設定",
  );
}

function makeUserCtx(content = "こんにちは") {
  return withPersona(
    createTurnContext({
      turnId: "t-user",
      state: "対話",
      trigger: { type: "user_message", content, speakerId: "u1" },
      dialogue,
      recentTurns: [],
      recalledEpisodes: [],
    }),
    "キャラクター設定",
  );
}

describe("generateDialogueSpeech — heartbeat/dialogue 統一フォーマット", () => {
  it("heartbeat: システムプロンプトに LANGUAGE_HEARTBEAT_SYSTEM_PREFIX を使う", async () => {
    const llm = new FakeLlmClient(['{"speech":"独り言","nextState":"静穏"}']);
    await generateDialogueSpeech(llm, makeHeartbeatCtx());
    const sys = llm.calls[0].messages.find((m) => m.role === "system");
    expect(sys?.content).toContain(LANGUAGE_HEARTBEAT_SYSTEM_PREFIX.slice(0, 20));
    expect(sys?.content).not.toContain(LANGUAGE_SYSTEM_PREFIX.slice(0, 20));
  });

  it("user_message: システムプロンプトに LANGUAGE_SYSTEM_PREFIX を使う", async () => {
    const llm = new FakeLlmClient(['{"speech":"返答","nextState":"対話"}']);
    await generateDialogueSpeech(llm, makeUserCtx());
    const sys = llm.calls[0].messages.find((m) => m.role === "system");
    expect(sys?.content).toContain(LANGUAGE_SYSTEM_PREFIX.slice(0, 20));
  });

  it("heartbeat: 状況行に「ハートビート」が含まれる", async () => {
    const llm = new FakeLlmClient(['{"speech":"","nextState":"静穏"}']);
    await generateDialogueSpeech(llm, makeHeartbeatCtx());
    const sys = llm.calls[0].messages.find((m) => m.role === "system");
    expect(sys?.content).toContain("ハートビート");
  });

  it("heartbeat: prior の独り言が assistant メッセージとして届く", async () => {
    const llm = new FakeLlmClient(['{"speech":"","nextState":"静穏"}']);
    const ctx = makeHeartbeatCtx([
      { role: "user", speakerId: "u1", content: "調べておいて" },
      { role: "assistant", channel: "monologue", content: "〇〇を調べた。次は△△を見よう" },
    ]);
    await generateDialogueSpeech(llm, ctx);
    const msgs = llm.calls[0].messages;
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    expect(assistantMsgs.some((m) => m.content.includes("〇〇を調べた"))).toBe(true);
  });

  it("heartbeat: prior の独り言が届く（user ターンなしでは届かない）", async () => {
    const llm = new FakeLlmClient(['{"speech":"","nextState":"静穏"}']);
    // user ターンなし → 先頭 assistant スキップ規則で monologue も届かない
    const ctx = makeHeartbeatCtx([
      { role: "assistant", channel: "monologue", content: "独り言だけ" },
    ]);
    await generateDialogueSpeech(llm, ctx);
    const msgs = llm.calls[0].messages;
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(0);
  });

  it("heartbeat: 最終メッセージが role:user で「（ハートビート）」", async () => {
    const llm = new FakeLlmClient(['{"speech":"","nextState":"静穏"}']);
    await generateDialogueSpeech(llm, makeHeartbeatCtx());
    const msgs = llm.calls[0].messages;
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain("（ハートビート）");
  });

  it("user_message: prior の独り言は multi-turn に含まれない", async () => {
    const llm = new FakeLlmClient(['{"speech":"返答","nextState":"対話"}']);
    const ctx = withPersona(
      createTurnContext({
        turnId: "t-u2",
        state: "対話",
        trigger: { type: "user_message", content: "どうだった？", speakerId: "u1" },
        dialogue,
        recentTurns: [
          { role: "user", speakerId: "u1", content: "調べておいて" },
          { role: "assistant", channel: "monologue", content: "独り言の内容" },
        ],
        recalledEpisodes: [],
      }),
      "キャラクター設定",
    );
    await generateDialogueSpeech(llm, ctx);
    const msgs = llm.calls[0].messages;
    expect(msgs.every((m) => !m.content.includes("独り言の内容"))).toBe(true);
  });
});
