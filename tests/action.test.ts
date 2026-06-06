import { describe, expect, it } from "vitest";
import { runAction } from "../src/roles/action.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import { NONE_ACTION } from "../src/action/types.js";
import {
  createTurnContext,
  withJudge,
} from "../src/context/turn-context.js";

const dialogue = {
  resolveUserDisplayName: () => "太郎",
};

function actionInput(action: typeof NONE_ACTION | { kind: "remember"; intent: string }) {
  const ctx = withJudge(
    createTurnContext({
      turnId: "turn-1",
      state: "対話",
      trigger: { type: "user_message", content: "test", speakerId: "u1" },
      dialogue,
      recentTurns: [],
      recalledEpisodes: [],
    }),
    { ACTION: action, REPLY: true, NEXT_STATE: "対話" },
  );
  return {
    ctx,
    episodes: new InMemoryEpisodeStore(),
    episodeRecallTopK: 3,
  };
}

describe("runAction dispatch", () => {
  it("returns notAttempted for none", async () => {
    const llm = new FakeLlmClient([]);
    const outcome = await runAction(llm, actionInput(NONE_ACTION));
    expect(outcome).toEqual({ attempted: false });
    expect(llm.calls).toHaveLength(0);
  });

  it("remember appends episode with source remember", async () => {
    const bodyJson = JSON.stringify({ body: "太郎はコーヒーが好き" });
    const llm = new FakeLlmClient([bodyJson]);
    const input = actionInput({ kind: "remember", intent: "好みを覚える" });
    const outcome = await runAction(llm, input);
    expect(outcome.attempted).toBe(true);
    if (outcome.attempted) {
      expect(outcome.status).toBe("succeeded");
    }
    expect(llm.calls[0].messages[1].content).toContain("基準日時:");
    expect(llm.calls[0].messages[1].content).toContain(
      input.ctx.currentDateTime,
    );
    const all = input.episodes.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].body).toBe("太郎はコーヒーが好き");
    expect(all[0].metadata.source).toBe("remember");
    expect(all[0].metadata.turnId).toBe("turn-1-remember");
    if (outcome.attempted) {
      expect(outcome.summary).toContain("LanceDB");
      expect(outcome.summary).toContain("太郎はコーヒーが好き");
      expect(outcome.facts).toEqual({
        kind: "remember",
        body: "太郎はコーヒーが好き",
      });
    }
  });
});
