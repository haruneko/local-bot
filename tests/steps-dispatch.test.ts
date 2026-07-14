import { describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/llm/fake.js";
import { runStepsDispatcher } from "../src/roles/steps-dispatch.js";

const baseInput = {
  goal: "ESP32-CAM で首振りカメラを作る",
  currentTask: "部品の値段を調べる",
  worksExcerpt: "",
  recentActions: "",
  hands: ["synthesize", "webSearch", "urlBrowse", "memo"],
};

describe("runStepsDispatcher", () => {
  it("有効な hand と intent を選んだらそのまま返す", async () => {
    const llm = new FakeLlmClient([
      '{"hand":"webSearch","intent":"ESP32-CAM の実売価格を調べる"}',
    ]);
    const result = await runStepsDispatcher(llm, baseInput);
    expect(result).toEqual({
      hand: "webSearch",
      intent: "ESP32-CAM の実売価格を調べる",
    });
    expect(llm.calls).toHaveLength(1);
  });

  it('none は「どの手でもできない」として intent 空で返す（呼び出し側が shelve）', async () => {
    const llm = new FakeLlmClient([
      '{"hand":"none","intent":"楽器の練習は自分ではできない"}',
    ]);
    const result = await runStepsDispatcher(llm, {
      ...baseInput,
      currentTask: "ギターを毎日30分練習する",
    });
    expect(result).toEqual({ hand: "none", intent: "" });
  });

  it("使える手が無ければ LLM を呼ばず null", async () => {
    const llm = new FakeLlmClient([]);
    const result = await runStepsDispatcher(llm, {
      ...baseInput,
      hands: [],
    });
    expect(result).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });

  it("未知の hand 名は hands から除外して判定する", async () => {
    const llm = new FakeLlmClient([
      '{"hand":"synthesize","intent":"読書メモを書く"}',
    ]);
    const result = await runStepsDispatcher(llm, {
      ...baseInput,
      hands: ["synthesize", "steps", "webcam"],
    });
    expect(result).toEqual({ hand: "synthesize", intent: "読書メモを書く" });
    const system = llm.calls[0]!.messages.find((m) => m.role === "system")!
      .content;
    expect(system).not.toContain("- steps:");
    expect(system).not.toContain("- webcam:");
  });

  it("候補に無い hand を選んだらリトライし、2回目の有効な答えを採用する", async () => {
    const llm = new FakeLlmClient([
      '{"hand":"steps","intent":"計画を整える"}',
      '{"hand":"synthesize","intent":"歌詞の続きを書く"}',
    ]);
    const result = await runStepsDispatcher(llm, baseInput);
    expect(result).toEqual({ hand: "synthesize", intent: "歌詞の続きを書く" });
    expect(llm.calls).toHaveLength(2);
  });

  it("パース不能が2回続いたら null（呼び出し側フォールバック）", async () => {
    const llm = new FakeLlmClient(["これはJSONではない", "まだJSONではない"]);
    const result = await runStepsDispatcher(llm, baseInput);
    expect(result).toBeNull();
    expect(llm.calls).toHaveLength(2);
  });

  it("intent が空の有効 hand は採用せずリトライする", async () => {
    const llm = new FakeLlmClient([
      '{"hand":"webSearch","intent":""}',
      '{"hand":"webSearch","intent":"サーボの型番を調べる"}',
    ]);
    const result = await runStepsDispatcher(llm, baseInput);
    expect(result).toEqual({ hand: "webSearch", intent: "サーボの型番を調べる" });
  });

  it("doer には currentTask だけ渡す＝user メッセージに現在のマイルストーンが載る", async () => {
    const llm = new FakeLlmClient([
      '{"hand":"webSearch","intent":"値段を調べる"}',
    ]);
    await runStepsDispatcher(llm, baseInput);
    const user = llm.calls[0]!.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("現在のマイルストーン：部品の値段を調べる");
    expect(user).toContain("目標：ESP32-CAM で首振りカメラを作る");
  });
});
