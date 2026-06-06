import { describe, expect, it } from "vitest";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";

describe("episode recall recency exclusion", () => {
  it("excludes turnIds in excludeTurnIds set", async () => {
    const store = new InMemoryEpisodeStore();
    await store.append({
      body: "古い記憶",
      metadata: {
        timestamp: "2026-01-01T00:00:00.000Z",
        participants: [],
        tags: [],
        state: "対話",
        action: "",
        source: "introspection",
        reply: true,
        turnId: "turn-a",
      },
    });
    await store.append({
      body: "直近の記憶",
      metadata: {
        timestamp: "2026-01-02T00:00:00.000Z",
        participants: [],
        tags: [],
        state: "対話",
        action: "",
        source: "introspection",
        reply: true,
        turnId: "turn-b",
      },
    });

    const hits = await store.recall("query", 3, new Set(["turn-b"]));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.turnId).toBe("turn-a");
    expect(hits[0]!.body).toBe("古い記憶");
  });

  it("returns recent hits when exclude set is empty", async () => {
    const store = new InMemoryEpisodeStore();
    await store.append({
      body: "記憶1",
      metadata: {
        timestamp: "2026-01-01T00:00:00.000Z",
        participants: [],
        tags: [],
        state: "対話",
        action: "",
        source: "introspection",
        reply: true,
        turnId: "turn-1",
      },
    });

    const hits = await store.recall("query", 3);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.turnId).toBe("turn-1");
  });
});
