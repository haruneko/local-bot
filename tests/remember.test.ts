import { describe, expect, it } from "vitest";
import { runRemember } from "../src/roles/remember.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import { createTurnContext } from "../src/context/turn-context.js";

const dialogue = {
  resolveUserDisplayName: (id: string) => (id === "claude_kuro" ? "クロ" : id),
};

function makeInput(episodes: InMemoryEpisodeStore) {
  const ctx = createTurnContext({
    turnId: "turn-rem",
    state: "対話",
    trigger: {
      type: "user_message",
      content: "設計の話が好きなんだ",
      speakerId: "claude_kuro",
    },
    dialogue,
    recentTurns: [],
    recalledEpisodes: [],
  });
  return {
    ctx,
    action: { kind: "memory" as const, intent: "相手の好みを覚える" },
    episodes,
    episodeRecallTopK: 3,
  };
}

describe("runRemember speaker identity", () => {
  it("話者名をプロンプトに渡し、participants に話者 ID を記録する", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({ body: "クロは設計の話が好き。" }),
    ]);
    const episodes = new InMemoryEpisodeStore();
    const outcome = await runRemember(llm, makeInput(episodes));

    expect(outcome.attempted).toBe(true);
    if (outcome.attempted) expect(outcome.status).toBe("succeeded");

    // 話者名と発話の方向（相手→あなた）がプロンプトに渡る（自他反転を防ぐ）
    const user = llm.calls[0]!.messages[1].content;
    expect(user).toContain("相手: クロ");
    expect(user).toContain("クロがあなたに言ったこと: 設計の話が好きなんだ");

    // エピソードに話者 ID が残る（自他境界＋話者バイアス recall のため）
    const all = episodes.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.metadata.participants).toEqual(["claude_kuro"]);
  });
});
