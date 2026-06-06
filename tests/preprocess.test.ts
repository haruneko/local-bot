import { describe, expect, it } from "vitest";
import { fitTurnContext } from "../src/context/preprocess.js";
import { createTurnContext } from "../src/context/turn-context.js";
import { fallbackRecalledEpisodes } from "../src/recall/distance.js";
import { FakeLlmClient } from "../src/llm/fake.js";

const dialogue = {
  resolveUserDisplayName: () => "太郎",
};

describe("fitTurnContext", () => {
  it("returns unchanged when under budget", async () => {
    const draft = createTurnContext({
      turnId: "t1",
      state: "対話",
      trigger: { type: "heartbeat" },
      dialogue,
      recentTurns: [],
      recalledEpisodes: [],
      now: new Date("2026-06-03T03:00:00.000Z"),
      timeZone: "Asia/Tokyo",
    });
    const llm = new FakeLlmClient([]);
    const result = await fitTurnContext(llm, draft, 6000);
    expect(result).toEqual(draft);
    expect(llm.calls).toHaveLength(0);
  });

  it("summarizes when over budget", async () => {
    const huge = "あ".repeat(30_000);
    const draft = createTurnContext({
      turnId: "t2",
      state: "対話",
      trigger: {
        type: "user_message",
        content: huge,
        speakerId: "user_001",
      },
      dialogue,
      recentTurns: [
        { role: "user", speakerId: "user_001", content: huge },
      ],
      recalledEpisodes: fallbackRecalledEpisodes([huge]),
      now: new Date("2026-06-03T03:00:00.000Z"),
      timeZone: "Asia/Tokyo",
    });
    const llm = new FakeLlmClient(["wm短", "ep短"]);
    const result = await fitTurnContext(llm, draft, 100);
    expect(llm.calls.length).toBeGreaterThan(0);
    expect(result.priorDialogueChannel).toBe("wm短");
    expect(result.recallDelivery).toBe("summarize");
  });
});
