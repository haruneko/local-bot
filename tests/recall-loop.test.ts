import { describe, expect, it } from "vitest";
import { runRecallLoop } from "../src/roles/agents/memory.js";
import { formatActionFactContent } from "../src/action/present.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import { createTurnContext } from "../src/context/turn-context.js";

const dialogue = { resolveUserDisplayName: () => "HAL" };

function makeCtx() {
  return createTurnContext({
    turnId: "turn-r",
    state: "対話",
    trigger: { type: "user_message", content: "記憶にあるコード進行教えて", speakerId: "u1" },
    dialogue,
    recentTurns: [],
    recalledEpisodes: [],
  });
}

describe("runRecallLoop — 空想起は捏造でなく正直に「思い当たらなかった」を返す", () => {
  it("該当記憶ゼロのとき、正直な回避文言を summary で返す（facts は付けない）", async () => {
    const episodes = new InMemoryEpisodeStore(); // 空＝ヒット0件
    // ループは runRecall（空）→ tool-pick の順。done を返させて1ステップで打ち切る
    const llm = new FakeLlmClient([JSON.stringify({ done: true, reason: "見当たらない" })]);

    const outcome = await runRecallLoop(llm, {
      ctx: makeCtx(),
      action: { kind: "memory", intent: "おすすめのコード進行" },
      episodes,
      episodeRecallTopK: 3,
    });

    expect(outcome.attempted).toBe(true);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.facts).toBeUndefined();
    expect(outcome.summary).toBe("記憶を探したが、思い当たるものは無かった");
  });

  it("その正直文言は language 宛にそのまま届く（捏造に化けない）", async () => {
    const episodes = new InMemoryEpisodeStore();
    const llm = new FakeLlmClient([JSON.stringify({ done: true, reason: "見当たらない" })]);

    const outcome = await runRecallLoop(llm, {
      ctx: makeCtx(),
      action: { kind: "memory", intent: "おすすめのコード進行" },
      episodes,
      episodeRecallTopK: 3,
    });

    const presented = formatActionFactContent(outcome, "language");
    expect(presented).toBe("記憶を探したが、思い当たるものは無かった");
  });
});
