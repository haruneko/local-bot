import { describe, expect, it } from "vitest";
import {
  stepsProgress,
  evaluateFocusGraduation,
  resolveFocusAfterActions,
} from "../src/steps/focus.js";
import type { StepsState } from "../src/steps/state.js";

function steps(over: Partial<StepsState> = {}): StepsState {
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

describe("stepsProgress", () => {
  it("完了マイルストーン数＋ログ数を数える", () => {
    expect(stepsProgress(steps())).toBe(0);
    expect(
      stepsProgress(
        steps({
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

describe("resolveFocusAfterActions", () => {
  const base = { current: "A", achievedOrCompleted: false, activateStepsId: "", setAsideStepsId: "" };

  it("達成/完了は最優先で手放す（activate より勝つ＝達成したターンに掴み直さない）", () => {
    expect(
      resolveFocusAfterActions({ ...base, achievedOrCompleted: true, activateStepsId: "B" }),
    ).toBe("");
  });

  it("達成でなければ明示 activate でその計画に乗り換える", () => {
    expect(resolveFocusAfterActions({ ...base, activateStepsId: "B" })).toBe("B");
  });

  it("activate は shelve より優先（両方あれば乗り換え）", () => {
    expect(
      resolveFocusAfterActions({ ...base, activateStepsId: "B", setAsideStepsId: "A" }),
    ).toBe("B");
  });

  it("いまの集中を shelve/retire したら手放す", () => {
    expect(resolveFocusAfterActions({ ...base, setAsideStepsId: "A" })).toBe("");
  });

  it("現 focus でない計画の shelve/retire は無視（巻き込まれない）", () => {
    expect(resolveFocusAfterActions({ ...base, setAsideStepsId: "B" })).toBe("A");
  });

  it("シグナルが無ければ現状維持", () => {
    expect(resolveFocusAfterActions(base)).toBe("A");
  });
});
