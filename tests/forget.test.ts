import { describe, expect, it } from "vitest";
import { runForget } from "../src/roles/forget.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import { createTurnContext } from "../src/context/turn-context.js";

const dialogue = { resolveUserDisplayName: () => "太郎" };

describe("runForget", () => {
  it("soft-deletes matching episode", async () => {
    const episodes = new InMemoryEpisodeStore();
    await episodes.append({
      body: "コーヒーが好きという話",
      metadata: {
        timestamp: new Date().toISOString(),
        participants: [],
        tags: [],
        state: "対話",
        action: "",
        source: "remember",
        reply: false,
        turnId: "ep-1",
      },
    });

    const pickJson = JSON.stringify({
      turnId: "ep-1",
      summary: "コーヒーの好み",
    });
    const llm = new FakeLlmClient([pickJson]);

    const ctx = createTurnContext({
      turnId: "turn-f",
      state: "対話",
      trigger: { type: "user_message", content: "忘れて", speakerId: "u1" },
      dialogue,
      recentTurns: [],
      recalledEpisodes: [],
    });

    const outcome = await runForget(llm, {
      ctx,
      action: { kind: "memory", intent: "コーヒーの話" },
      episodes,
      episodeRecallTopK: 3,
    });

    expect(outcome.attempted).toBe(true);
    if (outcome.attempted) {
      expect(outcome.status).toBe("succeeded");
      expect(outcome.facts).toEqual({
        kind: "forget",
        body: "コーヒーの好み",
      });
    }

    const after = await episodes.recall("コーヒー", 3);
    expect(after).toHaveLength(0);
  });
});
