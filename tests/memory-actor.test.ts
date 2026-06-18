import { describe, expect, it } from "vitest";
import { memoryActor } from "../src/actors/memory.js";
import { createTurnContext } from "../src/context/turn-context.js";
import { FakeLlmClient } from "../src/llm/fake.js";

const dialogue = { resolveUserDisplayName: () => "HAL" };

function ctxWith(content: string) {
  return createTurnContext({
    turnId: "t-mem",
    state: "対話",
    trigger: { type: "user_message", content, speakerId: "u1" },
    dialogue,
    recentTurns: [],
    recalledEpisodes: [],
  });
}

const channels = ["conversation", "inner_state"] as const;

describe("memoryActor.activate — 能動想起（recall 専用・忘却は減衰任せ）", () => {
  it("想起したいとき → active + intent", async () => {
    const llm = new FakeLlmClient(['{"active":true,"intent":"前に話したギター"}']);
    const r = await memoryActor.activate(llm, ctxWith("前にギターの話したっけ？"), [...channels]);
    expect(r?.intent).toBe("前に話したギター");
  });

  it("いまの会話で足りる → null（起動しない）", async () => {
    const llm = new FakeLlmClient(['{"active":false}']);
    const r = await memoryActor.activate(llm, ctxWith("こんにちは"), [...channels]);
    expect(r).toBeNull();
  });

  it("active だが intent 欠落 → null", async () => {
    const llm = new FakeLlmClient(['{"active":true}']);
    const r = await memoryActor.activate(llm, ctxWith("覚えてる？"), [...channels]);
    expect(r).toBeNull();
  });
});
