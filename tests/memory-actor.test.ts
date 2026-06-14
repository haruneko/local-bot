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

describe("memoryActor.activate — 想起/忘却の op を1判断で選ぶ（B'統合）", () => {
  it("忘却依頼 → op=forget", async () => {
    const llm = new FakeLlmClient([
      '{"active":true,"op":"forget","intent":"星座占いの話"}',
    ]);
    const r = await memoryActor.activate(llm, ctxWith("さっきの星座の話は忘れて"), [...channels]);
    expect(r?.op).toBe("forget");
    expect(r?.intent).toBe("星座占いの話");
  });

  it("想起 → op=recall", async () => {
    const llm = new FakeLlmClient([
      '{"active":true,"op":"recall","intent":"前に話したギター"}',
    ]);
    const r = await memoryActor.activate(llm, ctxWith("前にギターの話したっけ？"), [...channels]);
    expect(r?.op).toBe("recall");
  });

  it("op 欠落時は recall を既定にする", async () => {
    const llm = new FakeLlmClient(['{"active":true,"intent":"何か思い出す"}']);
    const r = await memoryActor.activate(llm, ctxWith("覚えてる？"), [...channels]);
    expect(r?.op).toBe("recall");
  });

  it("active:false → null（起動しない）", async () => {
    const llm = new FakeLlmClient(['{"active":false}']);
    const r = await memoryActor.activate(llm, ctxWith("こんにちは"), [...channels]);
    expect(r).toBeNull();
  });
});
