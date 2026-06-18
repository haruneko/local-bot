import { describe, expect, it } from "vitest";
import { runActivator, runMultiLabelActivator } from "../src/orchestrator/activator.js";
import { createTurnContext } from "../src/context/turn-context.js";
import { FakeLlmClient } from "../src/llm/fake.js";
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

function judge(name: ActorName, criteria: string): ActorRunner {
  return { name, criteria, run: async () => ({ attempted: false, name }) };
}

describe("runMultiLabelActivator", () => {
  const ALL = [
    judge("memo", "メモ"),
    judge("webSearch", "検索"),
    judge("plan", "計画"),
    judge("synthesize", "生成"),
  ];

  it("T-ML01: criteria 系を1発で判定し active なものだけ返す（LLM は1回）", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        memo: { active: true, intent: "ノートに残す" },
        webSearch: { active: false },
        plan: { active: false },
        synthesize: { active: false },
      }),
    ]);
    const result = await runMultiLabelActivator(llm, makeCtx(), ["conversation"], ALL);
    expect(result.map((r) => r.name)).toEqual(["memo"]);
    expect(result[0].intent).toBe("ノートに残す");
    expect(llm.calls).toHaveLength(1);
  });

  it("T-ML02: criteria を持たない actor だけなら LLM を呼ばず []", async () => {
    const llm = new FakeLlmClient([]);
    const gateOnly: ActorRunner = {
      name: "urlBrowse",
      activate: async () => null,
      run: async () => ({ attempted: false, name: "urlBrowse" }),
    };
    const result = await runMultiLabelActivator(llm, makeCtx(), ["conversation"], [gateOnly]);
    expect(result).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("T-ML03: active でも intent 空なら除外", async () => {
    const llm = new FakeLlmClient([JSON.stringify({ memo: { active: true } })]);
    const result = await runMultiLabelActivator(llm, makeCtx(), ["conversation"], [judge("memo", "メモ")]);
    expect(result).toEqual([]);
  });
});
