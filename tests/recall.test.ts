import { describe, expect, it } from "vitest";
import { runRecall } from "../src/roles/recall.js";
import { formatActionFactContent } from "../src/action/present.js";
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

async function seed(store: InMemoryEpisodeStore, bodies: string[]) {
  for (let i = 0; i < bodies.length; i++) {
    await store.append({
      body: bodies[i]!,
      metadata: {
        turnId: `t${i}`,
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        state: "対話",
        participants: ["u1"],
      },
    });
  }
}

describe("runRecall — 機械提示（LLM 要約なし・上位を原文で返す）", () => {
  it("空想起は捏造でなく正直に「思い当たらなかった」を summary で返す（facts なし）", async () => {
    const outcome = await runRecall({
      ctx: makeCtx(),
      action: { kind: "memory", intent: "おすすめのコード進行" },
      episodes: new InMemoryEpisodeStore(),
      episodeRecallTopK: 3,
    });

    expect(outcome.attempted).toBe(true);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.facts).toBeUndefined();
    expect(outcome.summary).toBe("記憶を探したが、思い当たるものは無かった");
    expect(formatActionFactContent(outcome, "language")).toBe(
      "記憶を探したが、思い当たるものは無かった",
    );
  });

  it("ヒットした上位 2 件の本文をそのまま bullets で返す（要約・LLM 呼び出しなし）", async () => {
    const episodes = new InMemoryEpisodeStore();
    // InMemory は「後に append したもの＝近い」順で返す。古い順に積む。
    await seed(episodes, ["遠い古い記憶（捨てる）", "来週また会う約束", "太郎はコーヒーが好き"]);

    const outcome = await runRecall(
      {
        ctx: makeCtx(),
        action: { kind: "memory", intent: "コーヒーの話" },
        episodes,
        episodeRecallTopK: 3,
        // InMemory の疑似距離は 0.35/0.68/... なので 2 件通すため緩める
        explicitRecallMaxDistance: 0.7,
      },
    );

    expect(outcome.attempted && outcome.facts?.kind === "recall").toBe(true);
    if (outcome.attempted && outcome.facts?.kind === "recall") {
      expect(outcome.facts.bullets).toEqual(["太郎はコーヒーが好き", "来週また会う約束"]);
      // 近い順 top-2 のみ。3 件目（遠い）は捨てる
      expect(outcome.facts.bullets).toHaveLength(2);
    }
  });
});
