import { describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/llm/fake.js";
import { runStepsProcessor } from "../src/roles/steps-processor.js";
import type { StepsState } from "../src/steps/state.js";

function steps(overrides: Partial<StepsState> = {}): StepsState {
  return {
    id: "p1",
    title: "テスト計画",
    goal: "段落を順に書く",
    milestones: [
      { id: "m1", text: "段落1を書く", done: false },
      { id: "m2", text: "段落2を書く", done: false },
      { id: "m3", text: "段落3を書く", done: false },
    ],
    current: "m1",
    log: [],
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

const yes = JSON.stringify({ satisfied: true });
const no = JSON.stringify({ satisfied: false });

describe("steps processor（前判定・マイルストーン照合）", () => {
  // T-PP01: works が m1,m2 を満たし m3 は未達 → 機械が m1,m2 を✓し current を m3 へ進める
  it("満たされたマイルストーンを順に✓し current を未完の先頭へ進める", async () => {
    const llm = new FakeLlmClient([yes, yes, no]);
    const result = await runStepsProcessor(llm, {
      steps: steps(),
      worksBody: "段落1の本文。段落2の本文。", actionResults: "書いた",
    });
    expect(result.completedIds).toEqual(["m1", "m2"]);
    expect(result.steps.milestones.map((m) => m.done)).toEqual([true, true, false]);
    expect(result.steps.current).toBe("m3");
    expect(result.allDone).toBe(false);
    expect(llm.calls).toHaveLength(3); // m1→m2→m3 を順に問う（m3 で止まる）
  });

  // T-PP02: 全マイルストーン達成 → allDone・current=null・達成ログ1回
  it("全マイルストーン達成で allDone・current=null・達成ログを足す", async () => {
    const llm = new FakeLlmClient([yes, yes]);
    const result = await runStepsProcessor(llm, {
      steps: steps({ milestones: [
        { id: "m1", text: "段落1を書く", done: false },
        { id: "m2", text: "段落2を書く", done: false },
      ] }),
      worksBody: "段落1。段落2。", actionResults: "書いた",
    });
    expect(result.allDone).toBe(true);
    expect(result.steps.current).toBeNull();
    expect(result.steps.milestones.every((m) => m.done)).toBe(true);
    expect(result.steps.log.some((e) => e.text.includes("達成"))).toBe(true);
  });

  // T-PP03: どれも満たされない → 変更なし（入力をそのまま返す・誤✓しない）
  it("満たされたものが無ければ計画を変えない", async () => {
    const input = steps();
    const llm = new FakeLlmClient([no]);
    const result = await runStepsProcessor(llm, { steps: input, worksBody: "", actionResults: "" });
    expect(result.completedIds).toEqual([]);
    expect(result.allDone).toBe(false);
    expect(result.steps).toBe(input); // 同一参照＝無変更
    expect(llm.calls).toHaveLength(1);
  });

  // T-PP04: 判定がパース不能なら未達扱い（誤✓を避ける）
  it("判定のパース失敗は未達として扱い✓しない", async () => {
    const llm = new FakeLlmClient(["これはJSONではない"]);
    const result = await runStepsProcessor(llm, { steps: steps(), worksBody: "なにか", actionResults: "なにか" });
    expect(result.completedIds).toEqual([]);
    expect(result.steps.milestones.every((m) => !m.done)).toBe(true);
  });

  // T-PP05: current が完了済みを指していても、実態（未完の先頭）に合わせて照合する
  it("current が stale（完了済み id）でも未完の先頭から照合する", async () => {
    const llm = new FakeLlmClient([yes, yes]);
    const result = await runStepsProcessor(llm, {
      steps: steps({
        milestones: [
          { id: "m1", text: "段落1を書く", done: true },
          { id: "m2", text: "段落2を書く", done: false },
          { id: "m3", text: "段落3を書く", done: false },
        ],
        current: "m1", // 完了済みを指している
      }),
      worksBody: "段落2。段落3。", actionResults: "書いた",
    });
    expect(result.completedIds).toEqual(["m2", "m3"]);
    expect(result.allDone).toBe(true);
  });
});
