import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyStepsOp } from "../src/steps/ops.js";
import { renderSteps } from "../src/steps/render.js";
import { loadSteps, saveSteps, stepsDir, type StepsState } from "../src/steps/state.js";
import { runSteps } from "../src/roles/steps.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import {
  buildActorContext,
  createTurnContext,
  renderLanguageUserContent,
} from "../src/context/turn-context.js";
import { notesDir } from "../src/tools/notes.js";

const NOW = new Date("2026-06-12T00:00:00.000Z");

// 本物の data/steps・data/notes/goals を汚さないよう temp に隔離する
// （stepsDir() は STEPS_DIR、notesDir() は MEMO_NOTES_DIR を優先する）。
let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "steps-"));
  process.env.STEPS_DIR = path.join(tmpRoot, "steps");
  process.env.MEMO_NOTES_DIR = path.join(tmpRoot, "notes");
});
afterEach(async () => {
  delete process.env.STEPS_DIR;
  delete process.env.MEMO_NOTES_DIR;
  await rm(tmpRoot, { recursive: true, force: true });
});

function sampleSteps(): StepsState {
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

describe("applyStepsOp（決定的・純関数）", () => {
  it("new_goal は milestone を採番し current を先頭にする", () => {
    const s = applyStepsOp(null, {
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
    const s = applyStepsOp(sampleSteps(), { op: "complete", id: "m1" }, NOW)!;
    expect(s.milestones.find((m) => m.id === "m1")!.done).toBe(true);
    expect(s.current).toBe("m2");
    // 重複も件数増加も起きない
    expect(s.milestones).toHaveLength(2);
  });

  it("log は履歴に1行足すだけ（マイルストーンは不変）", () => {
    const s = applyStepsOp(sampleSteps(), { op: "log", text: "1章読んだ" }, NOW)!;
    expect(s.log).toHaveLength(2);
    expect(s.log[1]!.text).toBe("1章読んだ");
    expect(s.milestones).toHaveLength(2);
  });

  it("noop は不変", () => {
    const before = sampleSteps();
    const s = applyStepsOp(before, { op: "noop" }, NOW)!;
    expect(s.milestones).toEqual(before.milestones);
    expect(s.log).toEqual(before.log);
  });

  it("既存 state が無いのに更新 op が来たら null", () => {
    expect(applyStepsOp(null, { op: "complete", id: "m1" }, NOW)).toBeNull();
  });
});

describe("renderSteps", () => {
  it("id とチェック状態を反映する", () => {
    const s = applyStepsOp(sampleSteps(), { op: "complete", id: "m1" }, NOW)!;
    const md = renderSteps(s);
    expect(md).toContain("- [x] (m1) 黄道12星座");
    expect(md).toContain("- [ ] (m2) 北天の星座  ← いまここ");
  });
});

describe("steps store", () => {
  it("save→load で往復し、無ければ null", async () => {
    const s = { ...sampleSteps(), id: "__test-store__" };
    const fpath = path.join(stepsDir(),`${s.id}.json`);
    try {
      expect(await loadSteps(s.id)).toBeNull();
      await saveSteps(s);
      expect((await loadSteps(s.id))!.title).toBe("星座を覚える");
    } finally {
      await rm(fpath, { force: true });
    }
  });
});

function makeInput(stepsId: string, intent: string) {
  const ctx = createTurnContext({
    turnId: "turn-steps",
    state: "集中",
    trigger: { type: "user_message", content: "進めよう", speakerId: "claude_kuro" },
    dialogue: { resolveUserDisplayName: (id) => (id === "claude_kuro" ? "クロ" : id) },
    recentTurns: [],
    recalledEpisodes: [],
    stepsId,
  });
  return { ctx, action: { kind: "memory" as const, intent }, episodes: new InMemoryEpisodeStore(), episodeRecallTopK: 3 };
}

describe("runSteps（op→決定的適用）", () => {
  it("new_goal で JSON を作成し steps facts.stepsId を返す", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({ op: "new_goal", title: "test-runsteps-new", goal: "G", milestones: ["x", "y"] }),
    ]);
    const o = await runSteps(llm, makeInput("", "計画を立てる"));
    expect(o.attempted && o.facts?.kind === "steps").toBe(true);
    if (o.attempted && o.facts?.kind === "steps") {
      const id = o.facts.stepsId;
      try {
        const saved = await loadSteps(id);
        expect(saved!.milestones).toHaveLength(2);
        expect(saved!.current).toBe("m1");
      } finally {
        await rm(path.join(stepsDir(),`${id}.json`), { force: true });
        await rm(path.join(notesDir(), "goals",`${id}.md`), { force: true });
      }
    }
  });

  it("既存 steps に complete op を当てると in-place 更新（重複なし・履歴保持）", async () => {
    const id = "__test-runsteps-complete__";
    const fpath = path.join(stepsDir(),`${id}.json`);
    const mpath = path.join(notesDir(), "goals",`${id}.md`);
    await saveSteps({ ...sampleSteps(), id });
    try {
      const llm = new FakeLlmClient([JSON.stringify({ op: "complete", id: "m1" })]);
      const o = await runSteps(llm, makeInput(id, "m1完了"));
      expect(o.attempted && o.facts?.kind === "steps" && o.facts.stepsId).toBe(id);
      const saved = await loadSteps(id);
      expect(saved!.milestones).toHaveLength(2); // 増えない
      expect(saved!.milestones.find((m) => m.id === "m1")!.done).toBe(true);
      expect(saved!.log[0]!.text).toBe("作成"); // 既存履歴を失わない
    } finally {
      await rm(fpath, { force: true });
      await rm(mpath, { force: true });
    }
  });

  it("noop は notAttempted（focusSteps/集中入室を起こさない）", async () => {
    const llm = new FakeLlmClient([JSON.stringify({ op: "noop" })]);
    const o = await runSteps(llm, makeInput("", "雑談"));
    expect(o.attempted).toBe(false);
  });

  it("最後のマイルストーンを complete するとゴール達成（achieved=true＋達成ログ）", async () => {
    const id = "__test-achieve__";
    const fpath = path.join(stepsDir(),`${id}.json`);
    const mpath = path.join(notesDir(), "goals",`${id}.md`);
    await saveSteps({
      ...sampleSteps(),
      id,
      milestones: [
        { id: "m1", text: "a", done: true },
        { id: "m2", text: "b", done: false },
      ],
      current: "m2",
    });
    try {
      const llm = new FakeLlmClient([JSON.stringify({ op: "complete", id: "m2" })]);
      const o = await runSteps(llm, makeInput(id, "m2完了"));
      expect(o.attempted && o.facts?.kind === "steps" && o.facts.achieved).toBe(true);
      const saved = await loadSteps(id);
      expect(saved!.milestones.every((m) => m.done)).toBe(true);
      expect(saved!.log.some((e) => e.text.includes("達成"))).toBe(true);
    } finally {
      await rm(fpath, { force: true });
      await rm(mpath, { force: true });
    }
  });

  it("計画プロンプトに計画一覧（backlog）と集中中の計画が渡る", async () => {
    await saveSteps({ ...sampleSteps(), id: "__bk-a__", title: "星座を覚える" });
    await saveSteps({ ...sampleSteps(), id: "__bk-b__", title: "歌詞を書く" });
    try {
      const llm = new FakeLlmClient([JSON.stringify({ op: "noop" })]);
      await runSteps(llm, makeInput("", "計画を見る"));
      const prompt = llm.calls[0]!.messages[1].content;
      expect(prompt).toContain("いまの計画一覧");
      expect(prompt).toContain("星座を覚える");
      expect(prompt).toContain("歌詞を書く");
    } finally {
      await rm(path.join(stepsDir(), "__bk-a__.json"), { force: true });
      await rm(path.join(stepsDir(), "__bk-b__.json"), { force: true });
    }
  });

  it("view(stepsId 無し) は backlog を報告するだけ（focus 変えず・action=view）", async () => {
    await saveSteps({ ...sampleSteps(), id: "__v-a__", title: "星座を覚える" });
    await saveSteps({ ...sampleSteps(), id: "__v-b__", title: "歌詞を書く" });
    try {
      const llm = new FakeLlmClient([JSON.stringify({ op: "view" })]);
      const o = await runSteps(llm, makeInput("", "やり残しある？"));
      expect(o.attempted && o.facts?.kind === "steps" && o.facts.action).toBe("view");
      if (o.attempted && o.facts?.kind === "steps") {
        expect(o.facts.body).toContain("星座を覚える");
        expect(o.facts.body).toContain("歌詞を書く");
      }
    } finally {
      await rm(path.join(stepsDir(), "__v-a__.json"), { force: true });
      await rm(path.join(stepsDir(), "__v-b__.json"), { force: true });
    }
  });

  it("view(stepsId 有り) はその計画の詳細を報告（読み取り専用＝始めない）", async () => {
    const id = "__v-one__";
    await saveSteps({ ...sampleSteps(), id });
    try {
      const llm = new FakeLlmClient([JSON.stringify({ op: "view", stepsId: id })]);
      const o = await runSteps(llm, makeInput("", "あの計画どうなってる？"));
      expect(o.attempted && o.facts?.kind === "steps" && o.facts.action).toBe("view");
      expect(o.attempted && o.facts?.kind === "steps" && o.facts.stepsId).toBe(id);
    } finally {
      await rm(path.join(stepsDir(), `${id}.json`), { force: true });
    }
  });

  it("activate は stepsId で既存計画を対象にし facts.action=activate を返す", async () => {
    const id = "__act__";
    await saveSteps({ ...sampleSteps(), id });
    try {
      const llm = new FakeLlmClient([JSON.stringify({ op: "activate", stepsId: id })]);
      const o = await runSteps(llm, makeInput("", "あれ再開しよう"));
      expect(o.attempted && o.facts?.kind === "steps" && o.facts.action).toBe("activate");
      expect(o.attempted && o.facts?.kind === "steps" && o.facts.stepsId).toBe(id);
    } finally {
      await rm(path.join(stepsDir(), `${id}.json`), { force: true });
      await rm(path.join(notesDir(), "goals", `${id}.md`), { force: true });
    }
  });

  it("shelve は facts.action=shelve（内容不変でも focus 副作用があるので通す）", async () => {
    const id = "__shv__";
    await saveSteps({ ...sampleSteps(), id });
    try {
      const llm = new FakeLlmClient([JSON.stringify({ op: "shelve", stepsId: id })]);
      const o = await runSteps(llm, makeInput(id, "棚上げ"));
      expect(o.attempted && o.facts?.kind === "steps" && o.facts.action).toBe("shelve");
    } finally {
      await rm(path.join(stepsDir(), `${id}.json`), { force: true });
      await rm(path.join(notesDir(), "goals", `${id}.md`), { force: true });
    }
  });

  it("retire は retired:true を保存し facts.action=retire", async () => {
    const id = "__ret__";
    await saveSteps({ ...sampleSteps(), id });
    try {
      const llm = new FakeLlmClient([JSON.stringify({ op: "retire", stepsId: id })]);
      const o = await runSteps(llm, makeInput(id, "もう見限る"));
      expect(o.attempted && o.facts?.kind === "steps" && o.facts.action).toBe("retire");
      expect((await loadSteps(id))!.retired).toBe(true);
    } finally {
      await rm(path.join(stepsDir(), `${id}.json`), { force: true });
      await rm(path.join(notesDir(), "goals", `${id}.md`), { force: true });
    }
  });

  it("new_goal の activate フラグで facts.action が activate / create に分かれる", async () => {
    const mk = (activate: boolean) =>
      new FakeLlmClient([
        JSON.stringify({ op: "new_goal", title: `__ng-${activate}__`, goal: "G", milestones: ["x"], activate }),
      ]);
    for (const activate of [true, false]) {
      const o = await runSteps(mk(activate), makeInput("", "計画"));
      try {
        expect(o.attempted && o.facts?.kind === "steps" && o.facts.action).toBe(
          activate ? "activate" : "create",
        );
      } finally {
        if (o.attempted && o.facts?.kind === "steps") {
          await rm(path.join(stepsDir(), `${o.facts.stepsId}.json`), { force: true });
          await rm(path.join(notesDir(), "goals", `${o.facts.stepsId}.md`), { force: true });
        }
      }
    }
  });

  it("効果ゼロの op（存在しない id への complete）は notAttempted", async () => {
    const id = "__test-noeffect__";
    const fpath = path.join(stepsDir(),`${id}.json`);
    await saveSteps({ ...sampleSteps(), id });
    try {
      const llm = new FakeLlmClient([JSON.stringify({ op: "complete", id: "m999" })]);
      const o = await runSteps(llm, makeInput(id, "存在しないid"));
      expect(o.attempted).toBe(false);
    } finally {
      await rm(fpath, { force: true });
    }
  });
});

describe("計画チャンネルの注入", () => {
  const ctxWithSteps = (steps: string) =>
    createTurnContext({
      turnId: "t",
      state: "集中",
      trigger: { type: "user_message", content: "やあ", speakerId: "claude_kuro" },
      dialogue: { resolveUserDisplayName: () => "クロ" },
      recentTurns: [],
      recalledEpisodes: [],
      steps,
    });

  it("steps が非空なら言語野コンテキストに steps 本文が入る", () => {
    const out = renderLanguageUserContent(ctxWithSteps("# 星座\n本文"));
    expect(out).toContain("# 星座");
  });

  it("steps が空なら注入しない", () => {
    expect(renderLanguageUserContent(ctxWithSteps(""))).not.toContain("# 星座");
  });

  it("steps チャンネルを宣言した actor のみ計画が入る", () => {
    const ctx = ctxWithSteps("# 星座");
    expect(buildActorContext(ctx, ["conversation", "inner_state", "steps"])).toContain("## 取り組み中の計画");
    expect(buildActorContext(ctx, ["conversation", "inner_state"])).not.toContain("## 取り組み中の計画");
  });
});
