import { describe, expect, it } from "vitest";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";

function record(turnId: string, participants: string[]) {
  return {
    body: `body-${turnId}`,
    metadata: {
      timestamp: new Date().toISOString(),
      participants,
      tags: [],
      state: "対話",
      action: "",
      source: "introspection" as const,
      reply: true,
      turnId,
    },
  };
}

describe("episode recall surfaces participants", () => {
  it("recall hit carries the episode's participants (for speaker bias)", async () => {
    const store = new InMemoryEpisodeStore();
    await store.append(record("t1", ["claude_kuro"]));

    const hits = await store.recall("anything", 3);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.participants).toEqual(["claude_kuro"]);
  });
});
