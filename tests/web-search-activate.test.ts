import { describe, expect, it } from "vitest";
import { webSearchActor } from "../src/actors/web-search.js";
import { createTurnContext } from "../src/context/turn-context.js";
import { FakeLlmClient } from "../src/llm/fake.js";

const dialogue = { resolveUserDisplayName: () => "太郎" };

function makeCtx(opts: { content?: string; affect?: string } = {}) {
  return createTurnContext({
    turnId: "turn-test",
    state: "静穏",
    trigger: { type: "heartbeat" },
    dialogue,
    recentTurns: [],
    recalledEpisodes: [],
    affect: opts.affect ?? "",
  });
}

const CHANNELS = ["conversation", "inner_state"] as const;

describe("webSearchActor.activate", () => {
  it("T-WS01: active:true → intent を返す", async () => {
    const llm = new FakeLlmClient(['{"active":true,"intent":"意味記憶のアーキテクチャを調べる"}']);
    const result = await webSearchActor.activate(llm, makeCtx(), [...CHANNELS]);
    expect(result).toEqual({ intent: "意味記憶のアーキテクチャを調べる", timeRange: undefined });
  });

  it("T-WS02: active:false → null を返す", async () => {
    const llm = new FakeLlmClient(['{"active":false}']);
    const result = await webSearchActor.activate(llm, makeCtx(), [...CHANNELS]);
    expect(result).toBeNull();
  });

  it("T-WS03: パース失敗 2 回 → null を返す", async () => {
    const llm = new FakeLlmClient(["invalid json", "also bad"]);
    const result = await webSearchActor.activate(llm, makeCtx(), [...CHANNELS]);
    expect(result).toBeNull();
  });

  it("T-WS04: システムプロンプトに指示ベース・内心ベース両方の記述がある", async () => {
    const llm = new FakeLlmClient(['{"active":false}']);
    await webSearchActor.activate(llm, makeCtx(), [...CHANNELS]);
    const systemMsg = llm.calls[0].messages.find((m) => m.role === "system");
    expect(systemMsg?.content).toContain("ユーザー");
    expect(systemMsg?.content).toContain("内心");
  });

  it("T-WS05: コンテキストに inner_state の内容が含まれる", async () => {
    const llm = new FakeLlmClient(['{"active":false}']);
    const ctx = makeCtx({ affect: "意味記憶について深く調べたい気持ちがある" });
    await webSearchActor.activate(llm, ctx, [...CHANNELS]);
    const userMsg = llm.calls[0].messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("意味記憶について深く調べたい気持ちがある");
  });
});
