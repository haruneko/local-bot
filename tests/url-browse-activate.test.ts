import { describe, expect, it } from "vitest";
import { urlBrowseActor } from "../src/actors/web-search.js";
import { createTurnContext } from "../src/context/turn-context.js";
import { FakeLlmClient } from "../src/llm/fake.js";

const dialogue = { resolveUserDisplayName: () => "太郎" };
const CHANNELS = ["conversation", "inner_state", "steps"] as const;

function ctxWith(content: string) {
  return createTurnContext({
    turnId: "t",
    state: "対話",
    trigger: { type: "heartbeat" },
    dialogue,
    recentTurns: [{ role: "user", speakerId: "u1", content }],
    recalledEpisodes: [],
    affect: "",
  });
}

describe("urlBrowseActor.activate — 客観ゲート（URL の有無で機械判定・LLM 不要）", () => {
  it("T-UB01: 会話に実 URL があれば起動し、intent に URL を載せる（LLM を呼ばない）", async () => {
    const llm = new FakeLlmClient([]); // 呼ばれたら応答切れ＝機械ゲートで呼ばれないことの確認
    const r = await urlBrowseActor.activate(
      llm,
      ctxWith("これ読んでみて https://example.com/article"),
      [...CHANNELS],
    );
    expect(r).not.toBeNull();
    expect(r?.intent).toContain("https://example.com/article");
    expect(llm.calls).toHaveLength(0);
  });

  it("T-UB02: URL が無ければ起動しない（null・LLM を呼ばない）", async () => {
    const llm = new FakeLlmClient([]);
    const r = await urlBrowseActor.activate(llm, ctxWith("今日はいい天気だね"), [...CHANNELS]);
    expect(r).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });
});
