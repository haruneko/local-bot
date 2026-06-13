import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSynthesize } from "../src/roles/synthesize.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import { InMemoryMemoIndexStore } from "../src/memory/memo-index.js";
import { createTurnContext } from "../src/context/turn-context.js";
import { readNoteContent, writeNoteContent } from "../src/tools/notes.js";

const dialogue = { resolveUserDisplayName: () => "HAL" };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "synth-"));
  process.env.MEMO_NOTES_DIR = dir;
});
afterEach(async () => {
  delete process.env.MEMO_NOTES_DIR;
  await rm(dir, { recursive: true, force: true });
});

function makeInput(
  intent: string,
  opts?: { planId?: string; plan?: string; memoIndex?: InMemoryMemoIndexStore },
) {
  const ctx = createTurnContext({
    turnId: "turn-synth",
    state: "集中",
    trigger: { type: "user_message", content: "歌詞書いて", speakerId: "u1" },
    dialogue,
    recentTurns: [],
    recalledEpisodes: [],
    planId: opts?.planId,
    plan: opts?.plan,
  });
  return {
    ctx,
    action: { kind: "memory" as const, intent },
    episodes: new InMemoryEpisodeStore(),
    episodeRecallTopK: 3,
    memoIndex: opts?.memoIndex,
  };
}

describe("runSynthesize（生成して成果物に外化する）", () => {
  it("計画があれば works/<planId>.md に新規生成し、_index と memoIndex を更新", async () => {
    const memoIndex = new InMemoryMemoIndexStore();
    const llm = new FakeLlmClient(["夜が明ける前の静けさを\n君の名で呼んでみる"]);
    const outcome = await runSynthesize(
      llm,
      makeInput("新曲のサビを書く", { planId: "新曲", plan: "ゴール: 新曲を作る", memoIndex }),
    );
    expect(outcome.attempted && outcome.status).toBe("succeeded");
    if (outcome.attempted && outcome.status === "succeeded") {
      expect(outcome.facts).toMatchObject({ kind: "synthesize", filename: "works/新曲.md" });
    }
    expect(await readNoteContent("works/新曲.md")).toContain("夜が明ける前");
    expect(await readNoteContent("works/_index.md")).toContain("新曲");
    expect((await memoIndex.list())[0].path).toBe("works/新曲.md");
  });

  it("既存の成果物があれば続きを append し、既存は保全する", async () => {
    await writeNoteContent("works/新曲.md", "Aメロ：街の灯が滲む");
    const llm = new FakeLlmClient(["サビ：それでも歩いていく"]);
    const outcome = await runSynthesize(
      llm,
      makeInput("サビを足す", { planId: "新曲" }),
    );
    expect(outcome.attempted && outcome.status).toBe("succeeded");
    const content = await readNoteContent("works/新曲.md");
    expect(content).toContain("Aメロ：街の灯が滲む"); // 保全
    expect(content).toContain("サビ：それでも歩いていく"); // 追記
  });

  it("計画が無ければ意図から works/<slug>.md に書く", async () => {
    const llm = new FakeLlmClient(["読書メモの本文"]);
    const outcome = await runSynthesize(llm, makeInput("星の王子さまの読書メモ"));
    expect(outcome.attempted && outcome.status).toBe("succeeded");
    if (outcome.attempted && outcome.status === "succeeded") {
      expect(outcome.facts.kind).toBe("synthesize");
      expect((outcome.facts as { filename: string }).filename).toMatch(/^works\/.+\.md$/);
    }
  });

  it("生成が空なら失敗で返す（成果物を作らない）", async () => {
    const llm = new FakeLlmClient(["   "]);
    const outcome = await runSynthesize(llm, makeInput("何か作って", { planId: "x" }));
    expect(outcome.attempted && outcome.status).toBe("failed");
    expect(await readNoteContent("works/x.md")).toBeNull();
  });

  it("facts.body はそのターンで作った一片（全文ではない）", async () => {
    await writeNoteContent("works/新曲.md", "既にある一連目");
    const llm = new FakeLlmClient(["新しい二連目だけ"]);
    const outcome = await runSynthesize(llm, makeInput("続き", { planId: "新曲" }));
    if (outcome.attempted && outcome.status === "succeeded") {
      expect((outcome.facts as { body: string }).body).toBe("新しい二連目だけ");
    } else {
      throw new Error("expected success");
    }
  });
});
