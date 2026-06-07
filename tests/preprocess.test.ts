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

  it("drops oldest working memory turns when over budget (no LLM call for WM)", async () => {
    const big = "あ".repeat(2000);
    const draft = createTurnContext({
      turnId: "t2",
      state: "対話",
      trigger: { type: "heartbeat" },
      dialogue,
      recentTurns: [
        { role: "user", speakerId: "user_001", content: big },
        { role: "assistant", content: big },
        { role: "user", speakerId: "user_001", content: big },
        { role: "assistant", content: big },
      ],
      recalledEpisodes: [],
      now: new Date("2026-06-03T03:00:00.000Z"),
      timeZone: "Asia/Tokyo",
    });
    const llm = new FakeLlmClient([]);
    const result = await fitTurnContext(llm, draft, 100);
    // 作業記憶のターンが削られ、LLM は呼ばれない
    expect(llm.calls).toHaveLength(0);
    expect(result.priorTurns.length).toBeLessThan(draft.priorTurns.length);
  });

  it("summarizes episodes when working memory drop is insufficient", async () => {
    const huge = "あ".repeat(30_000);
    const draft = createTurnContext({
      turnId: "t3",
      state: "対話",
      trigger: {
        type: "user_message",
        content: "こんにちは",
        speakerId: "user_001",
      },
      dialogue,
      recentTurns: [],
      recalledEpisodes: fallbackRecalledEpisodes([huge]),
      now: new Date("2026-06-03T03:00:00.000Z"),
      timeZone: "Asia/Tokyo",
    });
    const llm = new FakeLlmClient(["ep短"]);
    const result = await fitTurnContext(llm, draft, 100);
    // エピソードが LLM 要約される
    expect(llm.calls).toHaveLength(1);
    expect(result.recallDelivery).toBe("summarize");
  });
});
