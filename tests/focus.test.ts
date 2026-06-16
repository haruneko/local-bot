import { describe, expect, it } from "vitest";
import { planProgress, evaluateFocusGraduation } from "../src/plan/focus.js";
import type { PlanState } from "../src/plan/state.js";

function plan(over: Partial<PlanState> = {}): PlanState {
  return {
    id: "p",
    title: "t",
    goal: "g",
    milestones: [],
    current: null,
    log: [],
    createdAt: "2026-06-16",
    updatedAt: "2026-06-16",
    ...over,
  };
}

describe("planProgress", () => {
  it("完了マイルストーン数＋ログ数を数える", () => {
    expect(planProgress(plan())).toBe(0);
    expect(
      planProgress(
        plan({
          milestones: [
            { id: "1", text: "a", done: true },
            { id: "2", text: "b", done: false },
          ],
          log: [{ date: "2026-06-16", text: "やった" }],
        }),
      ),
    ).toBe(2);
  });
});

describe("evaluateFocusGraduation", () => {
  it("進捗が baseline を超えたら停滞リセット（卒業しない）", () => {
    const r = evaluateFocusGraduation({ progress: 3, stall: 4, baseline: 2, maxStall: 6 });
    expect(r).toEqual({ stall: 0, baseline: 3, graduated: false });
  });

  it("進捗が伸びなければ停滞を積む", () => {
    const r = evaluateFocusGraduation({ progress: 2, stall: 1, baseline: 2, maxStall: 6 });
    expect(r).toEqual({ stall: 2, baseline: 2, graduated: false });
  });

  it("停滞が maxStall に達したら卒業（graduated=true・カウントはリセット）", () => {
    const r = evaluateFocusGraduation({ progress: 2, stall: 5, baseline: 2, maxStall: 6 });
    expect(r.graduated).toBe(true);
    expect(r.stall).toBe(0);
    expect(r.baseline).toBe(0);
  });

  it("進捗が出たターンは停滞間際でも卒業しない", () => {
    const r = evaluateFocusGraduation({ progress: 5, stall: 5, baseline: 2, maxStall: 6 });
    expect(r.graduated).toBe(false);
    expect(r.stall).toBe(0);
    expect(r.baseline).toBe(5);
  });
});
