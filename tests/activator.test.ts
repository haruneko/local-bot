import { describe, expect, it } from "vitest";
import { runActivator } from "../src/orchestrator/activator.js";
import { createTurnContext } from "../src/context/turn-context.js";
import type { ActorRunner } from "../src/actors/types.js";
import type { ActorActivateResult } from "../src/actors/types.js";
import type { ActorName } from "../src/config/settings.js";

const dialogue = { resolveUserDisplayName: () => "太郎" };

function makeCtx(content = "テスト") {
  return createTurnContext({
    turnId: "turn-test",
    state: "対話",
    trigger: { type: "user_message", content, speakerId: "u1" },
    dialogue,
    recentTurns: [],
    recalledEpisodes: [],
  });
}

function mockActor(name: ActorName, result: ActorActivateResult | null): ActorRunner {
  return {
    name,
    activate: async () => result,
    run: async () => ({ attempted: false, name }),
  };
}

describe("runActivator", () => {
  it("T-AC01: actorSpecs が空のとき [] を返す", async () => {
    const result = await runActivator(makeCtx(), []);
    expect(result).toEqual([]);
  });

  it("T-AC02: activate が null を返す actor は含まれない", async () => {
    const specs = [
      { actor: mockActor("recall", null), llm: null as never, channels: [] as never },
      { actor: mockActor("forget", null), llm: null as never, channels: [] as never },
    ];
    const result = await runActivator(makeCtx(), specs);
    expect(result).toEqual([]);
  });

  it("T-AC03: activate が result を返す actor は ActiveActorSpec に変換される", async () => {
    const specs = [
      { actor: mockActor("recall", { intent: "過去の会話を思い出す" }), llm: null as never, channels: [] as never },
    ];
    const result = await runActivator(makeCtx(), specs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: "recall", intent: "過去の会話を思い出す", timeRange: undefined });
  });

  it("T-AC04: 複数 actor で部分的に activate → 有効なもののみ返す", async () => {
    const specs = [
      { actor: mockActor("recall",    { intent: "記憶を引き出す" }), llm: null as never, channels: [] as never },
      { actor: mockActor("forget",  null),                         llm: null as never, channels: [] as never },
      { actor: mockActor("webSearch", { intent: "天気を調べる" }),   llm: null as never, channels: [] as never },
    ];
    const result = await runActivator(makeCtx(), specs);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name)).toContain("recall");
    expect(result.map((r) => r.name)).toContain("webSearch");
  });

  it("T-AC05: timeRange が正しく引き継がれる", async () => {
    const specs = [
      {
        actor: mockActor("recall", {
          intent: "3日前の記憶",
          timeRange: { sinceDaysAgo: 3, untilDaysAgo: 1 },
        }),
        llm: null as never,
        channels: [] as never,
      },
    ];
    const result = await runActivator(makeCtx(), specs);
    expect(result).toHaveLength(1);
    expect(result[0].timeRange).toEqual({ sinceDaysAgo: 3, untilDaysAgo: 1 });
  });
});
