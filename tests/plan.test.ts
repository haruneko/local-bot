import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyPlanOp } from "../src/plan/ops.js";
import { renderPlan } from "../src/plan/render.js";
import { loadPlan, savePlan, plansDir, type PlanState } from "../src/plan/state.js";
import { runPlan } from "../src/roles/plan.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import {
  buildActorContext,
  createTurnContext,
  renderLanguageUserContent,
  withAction,
} from "../src/context/turn-context.js";
import { notesDir } from "../src/tools/notes.js";

const NOW = new Date("2026-06-12T00:00:00.000Z");

// 本物の data/plans・data/notes/goals を汚さないよう temp に隔離する
// （plansDir() は PLANS_DIR、notesDir() は MEMO_NOTES_DIR を優先する）。
let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "plan-"));
  process.env.PLANS_DIR = path.join(tmpRoot, "plans");
  process.env.MEMO_NOTES_DIR = path.join(tmpRoot, "notes");
});
afterEach(async () => {
  delete process.env.PLANS_DIR;
  delete process.env.MEMO_NOTES_DIR;
  await rm(tmpRoot, { recursive: true, force: true });
});

function samplePlan(): PlanState {
  return {
    id: "p",
    title: "星座を覚える",
    goal: "星空で識別できる",
    milestones: [
      { id: "m1", text: "黄道12星座", done: false },
      { id: "m2", text: "北天の星座", done: false },
    ],
    current: "m1",
    log: [{ date: "2026-06-12", text: "作成" }],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

describe("applyPlanOp（決定的・純関数）", () => {
  it("new_goal は milestone を採番し current を先頭にする", () => {
    const s = applyPlanOp(null, {
      op: "new_goal",
      title: "T",
      goal: "G",
      milestones: ["a", "b", "c"],
    }, NOW)!;
    expect(s.milestones.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(s.current).toBe("m1");
    expect(s.log).toHaveLength(1);
  });

  it("complete は done を立て、current だったら次の未完了へ前進する", () => {
    const s = applyPlanOp(samplePlan(), { op: "complete", id: "m1" }, NOW)!;
    expect(s.milestones.find((m) => m.id === "m1")!.done).toBe(true);
    expect(s.current).toBe("m2");
    // 重複も件数増加も起きない
    expect(s.milestones).toHaveLength(2);
  });

  it("log は履歴に1行足すだけ（マイルストーンは不変）", () => {
    const s = applyPlanOp(samplePlan(), { op: "log", text: "1章読んだ" }, NOW)!;
    expect(s.log).toHaveLength(2);
    expect(s.log[1]!.text).toBe("1章読んだ");
    expect(s.milestones).toHaveLength(2);
  });

  it("noop は不変", () => {
    const before = samplePlan();
    const s = applyPlanOp(before, { op: "noop" }, NOW)!;
    expect(s.milestones).toEqual(before.milestones);
    expect(s.log).toEqual(before.log);
  });

  it("既存 state が無いのに更新 op が来たら null", () => {
    expect(applyPlanOp(null, { op: "complete", id: "m1" }, NOW)).toBeNull();
  });
});

describe("renderPlan", () => {
  it("id とチェック状態を反映する", () => {
    const s = applyPlanOp(samplePlan(), { op: "complete", id: "m1" }, NOW)!;
    const md = renderPlan(s);
    expect(md).toContain("- [x] (m1) 黄道12星座");
    expect(md).toContain("- [ ] (m2) 北天の星座  ← いまここ");
  });
});

describe("plan store", () => {
  it("save→load で往復し、無ければ null", async () => {
    const s = { ...samplePlan(), id: "__test-store__" };
    const fpath = path.join(plansDir(),`${s.id}.json`);
    try {
      expect(await loadPlan(s.id)).toBeNull();
      await savePlan(s);
      expect((await loadPlan(s.id))!.title).toBe("星座を覚える");
    } finally {
      await rm(fpath, { force: true });
    }
  });
});

function makeInput(planId: string, intent: string) {
  const ctx = createTurnContext({
    turnId: "turn-plan",
    state: "集中",
    trigger: { type: "user_message", content: "進めよう", speakerId: "claude_kuro" },
    dialogue: { resolveUserDisplayName: (id) => (id === "claude_kuro" ? "クロ" : id) },
    recentTurns: [],
    recalledEpisodes: [],
    planId,
  });
  return { ctx, action: { kind: "memory" as const, intent }, episodes: new InMemoryEpisodeStore(), episodeRecallTopK: 3 };
}

describe("runPlan（op→決定的適用）", () => {
  it("new_goal で JSON を作成し plan facts.planId を返す", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({ op: "new_goal", title: "test-runplan-new", goal: "G", milestones: ["x", "y"] }),
    ]);
    const o = await runPlan(llm, makeInput("", "計画を立てる"));
    expect(o.attempted && o.facts?.kind === "plan").toBe(true);
    if (o.attempted && o.facts?.kind === "plan") {
      const id = o.facts.planId;
      try {
        const saved = await loadPlan(id);
        expect(saved!.milestones).toHaveLength(2);
        expect(saved!.current).toBe("m1");
      } finally {
        await rm(path.join(plansDir(),`${id}.json`), { force: true });
        await rm(path.join(notesDir(), "goals",`${id}.md`), { force: true });
      }
    }
  });

  it("既存 plan に complete op を当てると in-place 更新（重複なし・履歴保持）", async () => {
    const id = "__test-runplan-complete__";
    const fpath = path.join(plansDir(),`${id}.json`);
    const mpath = path.join(notesDir(), "goals",`${id}.md`);
    await savePlan({ ...samplePlan(), id });
    try {
      const llm = new FakeLlmClient([JSON.stringify({ op: "complete", id: "m1" })]);
      const o = await runPlan(llm, makeInput(id, "m1完了"));
      expect(o.attempted && o.facts?.kind === "plan" && o.facts.planId).toBe(id);
      const saved = await loadPlan(id);
      expect(saved!.milestones).toHaveLength(2); // 増えない
      expect(saved!.milestones.find((m) => m.id === "m1")!.done).toBe(true);
      expect(saved!.log[0]!.text).toBe("作成"); // 既存履歴を失わない
    } finally {
      await rm(fpath, { force: true });
      await rm(mpath, { force: true });
    }
  });

  it("noop は notAttempted（focusPlan/集中入室を起こさない）", async () => {
    const llm = new FakeLlmClient([JSON.stringify({ op: "noop" })]);
    const o = await runPlan(llm, makeInput("", "雑談"));
    expect(o.attempted).toBe(false);
  });

  it("最後のマイルストーンを complete するとゴール達成（achieved=true＋達成ログ）", async () => {
    const id = "__test-achieve__";
    const fpath = path.join(plansDir(),`${id}.json`);
    const mpath = path.join(notesDir(), "goals",`${id}.md`);
    await savePlan({
      ...samplePlan(),
      id,
      milestones: [
        { id: "m1", text: "a", done: true },
        { id: "m2", text: "b", done: false },
      ],
      current: "m2",
    });
    try {
      const llm = new FakeLlmClient([JSON.stringify({ op: "complete", id: "m2" })]);
      const o = await runPlan(llm, makeInput(id, "m2完了"));
      expect(o.attempted && o.facts?.kind === "plan" && o.facts.achieved).toBe(true);
      const saved = await loadPlan(id);
      expect(saved!.milestones.every((m) => m.done)).toBe(true);
      expect(saved!.log.some((e) => e.text.includes("達成"))).toBe(true);
    } finally {
      await rm(fpath, { force: true });
      await rm(mpath, { force: true });
    }
  });

  it("計画プロンプトに『このターンの行動結果』が渡る（失敗が見える＝事後グラウンディング）", async () => {
    let ctx = createTurnContext({
      turnId: "t",
      state: "集中",
      trigger: { type: "user_message", content: "進めよう", speakerId: "claude_kuro" },
      dialogue: { resolveUserDisplayName: () => "クロ" },
      recentTurns: [],
      recalledEpisodes: [],
      planId: "",
    });
    ctx = withAction(ctx, {
      attempted: true,
      kind: "research",
      intent: "曲のコードを調べる",
      status: "failed",
      summary: "失敗",
      error: { code: "tool_failed", message: "探索ツールに接続できない（fetch failed）" },
    });
    const llm = new FakeLlmClient([JSON.stringify({ op: "noop" })]);
    await runPlan(llm, {
      ctx,
      action: { kind: "memory" as const, intent: "進捗記録" },
      episodes: new InMemoryEpisodeStore(),
      episodeRecallTopK: 3,
    });
    const prompt = llm.calls[0]!.messages[1].content;
    expect(prompt).toContain("このターンで実際に起きたこと");
    // 失敗が明示ラベル＋理由として見える（事後グラウンディング）
    expect(prompt).toContain("結果: できなかった");
    expect(prompt).toContain("探索ツールに接続できない");
  });

  it("効果ゼロの op（存在しない id への complete）は notAttempted", async () => {
    const id = "__test-noeffect__";
    const fpath = path.join(plansDir(),`${id}.json`);
    await savePlan({ ...samplePlan(), id });
    try {
      const llm = new FakeLlmClient([JSON.stringify({ op: "complete", id: "m999" })]);
      const o = await runPlan(llm, makeInput(id, "存在しないid"));
      expect(o.attempted).toBe(false);
    } finally {
      await rm(fpath, { force: true });
    }
  });
});

describe("計画チャンネルの注入", () => {
  const ctxWithPlan = (plan: string) =>
    createTurnContext({
      turnId: "t",
      state: "集中",
      trigger: { type: "user_message", content: "やあ", speakerId: "claude_kuro" },
      dialogue: { resolveUserDisplayName: () => "クロ" },
      recentTurns: [],
      recalledEpisodes: [],
      plan,
    });

  it("plan が非空なら言語野コンテキストに「## 取り組み中の計画」が入る", () => {
    const out = renderLanguageUserContent(ctxWithPlan("# 星座\n本文"));
    expect(out).toContain("## 取り組み中の計画");
    expect(out).toContain("# 星座");
  });

  it("plan が空なら注入しない", () => {
    expect(renderLanguageUserContent(ctxWithPlan(""))).not.toContain("## 取り組み中の計画");
  });

  it("plan チャンネルを宣言した actor のみ計画が入る", () => {
    const ctx = ctxWithPlan("# 星座");
    expect(buildActorContext(ctx, ["conversation", "inner_state", "plan"])).toContain("## 取り組み中の計画");
    expect(buildActorContext(ctx, ["conversation", "inner_state"])).not.toContain("## 取り組み中の計画");
  });
});
