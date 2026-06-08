import { describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/llm/fake.js";
import { updateInnerState } from "../src/roles/inner-state.js";

describe("updateInnerState", () => {
  it("calls LLM with previous inner state and introspection", async () => {
    const llm = new FakeLlmClient(["ちょっと恥ずかしいな"]);
    const result = await updateInnerState(llm, {
      prevInnerState: "",
      introspection: "同じことを二度言ってしまった",
      speech: "ごめんね",
      actions: [],
      currentDateTime: "2026-06-06 10:00",
    });

    expect(result).toBe("ちょっと恥ずかしいな");
    expect(llm.calls).toHaveLength(1);
    const user = llm.calls[0]!.messages[1].content;
    expect(user).toContain("（まだない）");
    expect(user).toContain("同じことを二度言ってしまった");
    expect(user).toContain("ごめんね");
    expect(llm.calls[0]!.messages[0].content).toContain("前の内心");
  });

  it("includes previous inner state when non-empty", async () => {
    const llm = new FakeLlmClient(["謝って少し落ち着いた"]);
    await updateInnerState(llm, {
      prevInnerState: "恥ずかしかった",
      introspection: "謝ったら少し楽になった",
      speech: null,
      actions: [],
      currentDateTime: "2026-06-06 10:05",
    });

    expect(llm.calls[0]!.messages[1].content).toContain("恥ずかしかった");
  });
});
