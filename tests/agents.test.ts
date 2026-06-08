import { describe, expect, it } from "vitest";
import { runMemoryAgent } from "../src/agents/memory.js";
import { runResearchAgent } from "../src/agents/research.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { FakeMcpToolProvider } from "../src/mcp/fake.js";
import { buildToolCatalog } from "../src/tools/catalog.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import { createTurnContext } from "../src/context/turn-context.js";
import { defaultRunActionDeps } from "../src/action/context.js";

const dialogue = { resolveUserDisplayName: () => "太郎" };

function makeCtx(content = "テスト") {
  return createTurnContext({
    turnId: "turn-test",
    state: "対話",
    trigger: { type: "user_message", content, speakerId: "u1" },
    dialogue,
    recentTurns: [],
    recalledEpisodes: [],
  });
}

describe("runMemoryAgent", () => {
  it("T-MA01: activate=false → notAttempted（LLM 1回のみ）", async () => {
    const llm = new FakeLlmClient([JSON.stringify({ activate: false })]);
    const deps = defaultRunActionDeps(new InMemoryEpisodeStore(), 3);
    const result = await runMemoryAgent(llm, makeCtx(), deps);
    expect(result.attempted).toBe(false);
    expect(llm.calls).toHaveLength(1);
  });

  it("T-MA02: activate=true, tool=remember → succeeded アクション", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({ activate: true, tool: "remember", intent: "好みを覚える" }),
      JSON.stringify({ body: "ユーザーはコーヒーが好き" }),
    ]);
    const episodes = new InMemoryEpisodeStore();
    const deps = defaultRunActionDeps(episodes, 3);
    const result = await runMemoryAgent(llm, makeCtx("コーヒーが好きって覚えておいて"), deps);
    expect(result.attempted).toBe(true);
    if (result.attempted) {
      expect(result.status).toBe("succeeded");
      expect(result.kind).toBe("memory");
    }
    expect(episodes.getAll()).toHaveLength(1);
  });

  it("T-MA03: activate=true だが tool 未指定 → notAttempted", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({ activate: true, intent: "何かしたい" }),
    ]);
    const deps = defaultRunActionDeps(new InMemoryEpisodeStore(), 3);
    const result = await runMemoryAgent(llm, makeCtx(), deps);
    expect(result.attempted).toBe(false);
  });
});

describe("runResearchAgent", () => {
  it("T-RA01: activate=false → notAttempted（LLM 1回のみ）", async () => {
    const llm = new FakeLlmClient([JSON.stringify({ activate: false })]);
    const deps = defaultRunActionDeps(new InMemoryEpisodeStore(), 3);
    const result = await runResearchAgent(llm, makeCtx(), deps);
    expect(result.attempted).toBe(false);
    expect(llm.calls).toHaveLength(1);
  });

  it("T-RA02: activate=true, intent あり → succeeded アクション", async () => {
    const mcp = new FakeMcpToolProvider();
    const toolCatalog = await buildToolCatalog(mcp);
    const llm = new FakeLlmClient([
      JSON.stringify({ activate: true, intent: "今日の天気を調べる" }),
      JSON.stringify({ done: false, tool: "web_search", arguments: { query: "今日の天気" } }),
      JSON.stringify({ done: true, reason: "完了" }),
    ]);
    const deps = defaultRunActionDeps(new InMemoryEpisodeStore(), 3, { mcp, toolCatalog });
    const result = await runResearchAgent(llm, makeCtx("今日の天気を調べて"), deps);
    expect(result.attempted).toBe(true);
    if (result.attempted) {
      expect(result.status).toBe("succeeded");
      expect(result.kind).toBe("research");
    }
  });

  it("T-RA03: activate=true だが intent 未指定 → notAttempted", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({ activate: true }),
    ]);
    const deps = defaultRunActionDeps(new InMemoryEpisodeStore(), 3);
    const result = await runResearchAgent(llm, makeCtx(), deps);
    expect(result.attempted).toBe(false);
  });
});
