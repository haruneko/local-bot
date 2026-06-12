import { describe, expect, it } from "vitest";
import { runAction } from "../src/roles/action.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import { NONE_ACTION } from "../src/action/types.js";
import { memoryCatalogTools } from "../src/tools/catalog.js";
import { createTurnContext } from "../src/context/turn-context.js";
import type { AbstractAction } from "../src/action/types.js";

const dialogue = {
  resolveUserDisplayName: () => "太郎",
};

function actionInput(action: AbstractAction) {
  const ctx = createTurnContext({
    turnId: "turn-1",
    state: "対話",
    trigger: { type: "user_message", content: "test", speakerId: "u1" },
    dialogue,
    recentTurns: [],
    recalledEpisodes: [],
  });
  return {
    ctx,
    action,
    episodes: new InMemoryEpisodeStore(),
    episodeRecallTopK: 3,
    toolCatalog: memoryCatalogTools(),
  };
}

describe("runAction dispatch", () => {
  it("returns notAttempted for none", async () => {
    const llm = new FakeLlmClient([]);
    const outcome = await runAction(llm, actionInput(NONE_ACTION));
    expect(outcome).toEqual({ attempted: false });
    expect(llm.calls).toHaveLength(0);
  });

  it("memory→remember appends episode with source remember", async () => {
    const subagentPick = JSON.stringify({
      done: false,
      tool: "remember",
      arguments: {},
    });
    const bodyJson = JSON.stringify({ body: "太郎はコーヒーが好き" });
    const llm = new FakeLlmClient([subagentPick, bodyJson]);
    const input = actionInput({ kind: "memory", intent: "好みを覚える" });
    const outcome = await runAction(llm, input);
    expect(outcome.attempted).toBe(true);
    if (outcome.attempted) {
      expect(outcome.status).toBe("succeeded");
      expect(outcome.kind).toBe("memory");
    }
    const rememberPrompt = llm.calls[1].messages
      .map((m) => m.content)
      .join("\n");
    expect(rememberPrompt).toContain("基準日時:");
    expect(rememberPrompt).toContain(input.ctx.currentDateTime);
    const all = input.episodes.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].body).toBe("太郎はコーヒーが好き");
    expect(all[0].metadata.source).toBe("remember");
    expect(all[0].metadata.turnId).toBe("turn-1-remember");
    if (outcome.attempted) {
      expect(outcome.summary).toContain("記憶に残した");
      expect(outcome.facts).toEqual({
        kind: "remember",
        body: "太郎はコーヒーが好き",
      });
    }
  });
});
