import { describe, expect, it } from "vitest";
import { TurnOrchestrator } from "../src/orchestrator/turn.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import { WorkingMemory } from "../src/memory/working.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { DEFAULT_RECALL_DISTANCE_THRESHOLDS } from "../src/recall/distance.js";

describe("TurnOrchestrator", () => {
  it("T-T01: clears turn context after turn", async () => {
    const judgeJson = JSON.stringify({
      ACTION: { kind: "none", intent: "" },
      REPLY: true,
      NEXT_STATE: "対話",
    });
    const llm = new FakeLlmClient([
      judgeJson,
      "ボットの返答です",
      "内省テキストです",
    ]);
    const episodes = new InMemoryEpisodeStore();
    const orch = new TurnOrchestrator("対話", {
      llm,
      episodes,
      workingMemory: new WorkingMemory(20),
      episodeRecallTopK: 3,
      recallDistanceThresholds: DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      contextTokenBudget: 6000,
      getPersona: async () => "test persona",
      dialogue: {
        resolveUserDisplayName: () => "太郎",
      },
    });

    await orch.run({
      type: "user_message",
      content: "やあ",
      speakerId: "user_001",
    });

    expect(orch.getTurnContext()).toBeNull();
    expect(episodes.getAll()).toHaveLength(1);
    expect(episodes.getAll()[0].metadata.source).toBe("introspection");
  });

  it("REPLY=false still runs introspection and skips assistant memory", async () => {
    const judgeJson = JSON.stringify({
      ACTION: { kind: "none", intent: "" },
      REPLY: false,
      NEXT_STATE: "静穏",
    });
    const llm = new FakeLlmClient([judgeJson, "内省のみ"]);
    const wm = new WorkingMemory(20);
    const orch = new TurnOrchestrator("対話", {
      llm,
      episodes: new InMemoryEpisodeStore(),
      workingMemory: wm,
      episodeRecallTopK: 3,
      recallDistanceThresholds: DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      contextTokenBudget: 6000,
      getPersona: async () => "",
      dialogue: {
        resolveUserDisplayName: () => "太郎",
      },
    });

    const result = await orch.run({
      type: "user_message",
      content: "……",
      speakerId: "user_001",
    });

    expect(result.speech).toBeNull();
    expect(llm.calls).toHaveLength(2);
    const introCall = llm.calls[1];
    expect(introCall.messages[1].content).toContain(
      "（返答はしなかった）",
    );
    expect(wm.getRecent().some((t) => t.role === "assistant")).toBe(false);
  });

  it("idle heartbeat skips introspection LLM and episode append", async () => {
    const judgeJson = JSON.stringify({
      ACTION: { kind: "none", intent: "" },
      REPLY: false,
      NEXT_STATE: "静穏",
    });
    const llm = new FakeLlmClient([judgeJson]);
    const episodes = new InMemoryEpisodeStore();
    const orch = new TurnOrchestrator("静穏", {
      llm,
      episodes,
      workingMemory: new WorkingMemory(20),
      episodeRecallTopK: 3,
      recallDistanceThresholds: DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      contextTokenBudget: 6000,
      getPersona: async () => "",
      dialogue: {
        resolveUserDisplayName: () => "太郎",
      },
    });

    const result = await orch.run({ type: "heartbeat" });

    expect(result.episodeSaved).toBe(false);
    expect(result.introspection).toBe("");
    expect(llm.calls).toHaveLength(1);
    expect(episodes.getAll()).toHaveLength(0);
  });

  it("heartbeat REPLY appends monologue to working memory", async () => {
    const judgeJson = JSON.stringify({
      ACTION: { kind: "none", intent: "" },
      REPLY: true,
      NEXT_STATE: "対話",
    });
    const llm = new FakeLlmClient([judgeJson, "独り言セリフ", "内省"]);
    const wm = new WorkingMemory(20, [
      { role: "user", speakerId: "user_001", content: "前の質問" },
    ]);
    const orch = new TurnOrchestrator("対話", {
      llm,
      episodes: new InMemoryEpisodeStore(),
      workingMemory: wm,
      episodeRecallTopK: 3,
      recallDistanceThresholds: DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      contextTokenBudget: 6000,
      getPersona: async () => "",
      dialogue: {
        resolveUserDisplayName: () => "太郎",
      },
    });

    await orch.run({ type: "heartbeat" });

    expect(wm.getRecent()).toEqual([
      { role: "user", speakerId: "user_001", content: "前の質問" },
      { role: "assistant", channel: "monologue", content: "独り言セリフ" },
    ]);
  });

  it("heartbeat ACTION success with REPLY false still runs language monologue", async () => {
    const judgeJson = JSON.stringify({
      ACTION: { kind: "memory", intent: "CONCEPT.md を読む" },
      REPLY: false,
      NEXT_STATE: "対話",
    });
    const llm = new FakeLlmClient([
      judgeJson,
      "CONCEPT.md は設計書だった。次は別メモも見よう",
      "内省テキスト",
    ]);
    const wm = new WorkingMemory(20, [
      { role: "user", speakerId: "user_001", content: "メモ見て" },
    ]);
    const episodes = new InMemoryEpisodeStore();
    const orch = new TurnOrchestrator("対話", {
      llm,
      episodes,
      workingMemory: wm,
      episodeRecallTopK: 3,
      recallDistanceThresholds: DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      contextTokenBudget: 6000,
      getPersona: async () => "",
      dialogue: {
        resolveUserDisplayName: () => "太郎",
      },
      runAction: async () => ({
        attempted: true,
        kind: "memory",
        intent: "CONCEPT.md を読む",
        status: "succeeded",
        facts: {
          kind: "memo_read",
          filename: "CONCEPT.md",
          body: "設計書",
        },
        summary: "data/notes/CONCEPT.md を読んだ:\n設計書",
      }),
    });

    const result = await orch.run({ type: "heartbeat" });

    expect(result.speech).toBe("CONCEPT.md は設計書だった。次は別メモも見よう");
    expect(llm.calls).toHaveLength(3);
    expect(wm.getRecent()[1]).toEqual({
      role: "assistant",
      channel: "monologue",
      content: "CONCEPT.md は設計書だった。次は別メモも見よう",
    });
    expect(result.episodeSaved).toBe(true);
  });
});
