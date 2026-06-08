import { describe, expect, it } from "vitest";
import { runActivator } from "../src/orchestrator/activator.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { createTurnContext } from "../src/context/turn-context.js";

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

describe("runActivator", () => {
  it("T-AC01: actor リストが空のとき LLM を呼ばず [] を返す", async () => {
    const llm = new FakeLlmClient([]);
    const result = await runActivator(llm, makeCtx(), []);
    expect(result).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("T-AC02: active=[] → 空配列を返す", async () => {
    const llm = new FakeLlmClient([JSON.stringify({ active: [] })]);
    const result = await runActivator(llm, makeCtx(), ["recall", "remember"]);
    expect(result).toEqual([]);
    expect(llm.calls).toHaveLength(1);
  });

  it("T-AC03: 有効な actor spec → ActiveActorSpec を返す", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        active: [{ name: "recall", intent: "過去の会話を思い出す" }],
      }),
    ]);
    const result = await runActivator(llm, makeCtx(), ["recall", "remember"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: "recall", intent: "過去の会話を思い出す", timeRange: undefined });
  });

  it("T-AC04: 不正 JSON が 2 回続いたら [] にフォールバック", async () => {
    const llm = new FakeLlmClient(["not-json", "also-not-json"]);
    const result = await runActivator(llm, makeCtx(), ["recall"]);
    expect(result).toEqual([]);
    expect(llm.calls).toHaveLength(2);
  });

  it("T-AC05: actorNames にない名前はフィルタされる", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        active: [
          { name: "recall",   intent: "記憶を引き出す" },
          { name: "webcam",   intent: "カメラを使う" },
        ],
      }),
    ]);
    // webcam は actorNames に含まれない
    const result = await runActivator(llm, makeCtx(), ["recall"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("recall");
  });

  it("T-AC06: time_range が正しくマッピングされる", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        active: [
          {
            name: "recall",
            intent: "3日前の記憶を検索",
            time_range: { since_days_ago: 3, until_days_ago: 1 },
          },
        ],
      }),
    ]);
    const result = await runActivator(llm, makeCtx(), ["recall"]);
    expect(result).toHaveLength(1);
    expect(result[0].timeRange).toEqual({ sinceDaysAgo: 3, untilDaysAgo: 1 });
  });

  it("T-AC07: intent が空文字列の actor はフィルタされる", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        active: [
          { name: "recall",  intent: "" },
          { name: "remember", intent: "今日の話を記録する" },
        ],
      }),
    ]);
    const result = await runActivator(llm, makeCtx(), ["recall", "remember"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("remember");
  });
});
