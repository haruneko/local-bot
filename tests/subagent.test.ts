import { describe, expect, it } from "vitest";
import { runAction } from "../src/roles/action.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { FakeMcpToolProvider } from "../src/mcp/fake.js";
import { buildToolCatalog } from "../src/tools/catalog.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import { createTurnContext } from "../src/context/turn-context.js";

const dialogue = { resolveUserDisplayName: () => "太郎" };

async function makeInput(intent: string, kind: "research" | "express") {
  const mcp = new FakeMcpToolProvider();
  const toolCatalog = await buildToolCatalog(mcp);
  const ctx = createTurnContext({
    turnId: "turn-sub",
    state: "対話",
    trigger: { type: "user_message", content: "test", speakerId: "u1" },
    dialogue,
    recentTurns: [],
    recalledEpisodes: [],
  });
  return {
    ctx,
    action: { kind, intent },
    episodes: new InMemoryEpisodeStore(),
    episodeRecallTopK: 3,
    mcp,
    toolCatalog,
    expressDryRun: true,
  };
}

describe("category subagents", () => {
  it("research runs MCP web_search", async () => {
    const pick = JSON.stringify({
      done: false,
      tool: "web_search",
      arguments: { query: "天気" },
    });
    const done = JSON.stringify({ done: true, reason: "十分" });
    const llm = new FakeLlmClient([pick, done]);
    const input = await makeInput("今日の天気", "research");
    const outcome = await runAction(llm, input);
    expect(outcome.attempted).toBe(true);
    if (outcome.attempted) {
      expect(outcome.status).toBe("succeeded");
      expect(outcome.kind).toBe("research");
      expect(outcome.facts?.kind).toBe("research");
    }
    expect(input.mcp.calls[0]?.name).toBe("web_search");
  });

  it("research recovers an object-wrapped url arg before calling MCP", async () => {
    // 小型モデルが url: string のところへ {url: "..."} を入れてしまうケース
    const pick = JSON.stringify({
      done: false,
      tool: "browse_url",
      arguments: { url: { url: "https://example.com" } },
    });
    const done = JSON.stringify({ done: true, reason: "十分" });
    const llm = new FakeLlmClient([pick, done]);
    const input = await makeInput("そのページを見て", "research");
    const outcome = await runAction(llm, input);
    expect(outcome.attempted).toBe(true);
    if (outcome.attempted) expect(outcome.status).toBe("succeeded");
    // MCP には平坦な文字列 url が渡る
    expect(input.mcp.calls[0]?.name).toBe("browse_url");
    expect(input.mcp.calls[0]?.args).toEqual({ url: "https://example.com" });
  });

  it("research fails gracefully (not as network error) on unrecoverable args", async () => {
    // url を復元できない → MCP を叩かず、リトライ余地を残して最終的に失敗
    const bad = JSON.stringify({
      done: false,
      tool: "browse_url",
      arguments: { url: { a: 1, b: 2 } },
    });
    const llm = new FakeLlmClient([bad, bad, bad, bad, bad]);
    const input = await makeInput("そのページを見て", "research");
    const outcome = await runAction(llm, input);
    expect(outcome.attempted).toBe(true);
    if (outcome.attempted) {
      expect(outcome.status).toBe("failed");
      expect(outcome.error?.message).toContain("url");
    }
    // 引数不正で MCP は一度も呼ばれない
    expect(input.mcp.calls).toHaveLength(0);
  });

  it("research returns failed (not succeeded) when tool-pick LLM output is unparseable", async () => {
    // ツール選択の LLM が JSON にならない（2回とも失敗）→ 偽成功にしない
    const llm = new FakeLlmClient(["これはJSONじゃない", "やっぱりJSONじゃない"]);
    const input = await makeInput("何か調べて", "research");
    const outcome = await runAction(llm, input);
    expect(outcome.attempted).toBe(true);
    if (outcome.attempted) {
      expect(outcome.status).toBe("failed");
      expect(outcome.error?.code).toBe("llm_parse_failed");
    }
    // ツールは一度も呼ばれない
    expect(input.mcp.calls).toHaveLength(0);
  });

  it("express dry-run composes text without MCP call", async () => {
    const pick = JSON.stringify({
      done: false,
      tool: "post_tweet",
      arguments: {},
    });
    const composed = "今日はいい天気だね";
    const llm = new FakeLlmClient([pick, composed]);
    const input = await makeInput("感想をツイート", "express");
    const outcome = await runAction(llm, input);
    expect(outcome.attempted).toBe(true);
    if (outcome.attempted) {
      expect(outcome.status).toBe("succeeded");
      expect(outcome.facts?.kind).toBe("express");
      if (outcome.facts?.kind === "express") {
        expect(outcome.facts.title).toContain("[dry-run]");
        expect(outcome.facts.body).toBe(composed);
      }
    }
    expect(input.mcp.calls).toHaveLength(0);
  });
});
