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
  opts?: {
    stepsId?: string;
    steps?: string;
    currentTask?: string;
    memoIndex?: InMemoryMemoIndexStore;
  },
) {
  const ctx = createTurnContext({
    turnId: "turn-synth",
    state: "集中",
    trigger: { type: "user_message", content: "歌詞書いて", speakerId: "u1" },
    dialogue,
    recentTurns: [],
    recalledEpisodes: [],
    stepsId: opts?.stepsId,
    steps: opts?.steps,
    currentTask: opts?.currentTask,
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
  it("計画があれば works/<stepsId>.md に新規生成し、_index と memoIndex を更新", async () => {
    const memoIndex = new InMemoryMemoIndexStore();
    const llm = new FakeLlmClient(["夜が明ける前の静けさを\n君の名で呼んでみる"]);
    const outcome = await runSynthesize(
      llm,
      makeInput("新曲のサビを書く", { stepsId: "新曲", steps: "ゴール: 新曲を作る", memoIndex }),
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
      makeInput("サビを足す", { stepsId: "新曲" }),
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
    const outcome = await runSynthesize(llm, makeInput("何か作って", { stepsId: "x" }));
    expect(outcome.attempted && outcome.status).toBe("failed");
    expect(await readNoteContent("works/x.md")).toBeNull();
  });

  // 集中の doer steering: currentTask があれば、それだけを渡し計画全体（先のステップ）は見せない
  it("currentTask があれば current タスクだけを渡し、計画全体は渡さない（先走り防止）", async () => {
    const llm = new FakeLlmClient(["モチーフ：夜明けの光／霧／静かな水面"]);
    await runSynthesize(
      llm,
      makeInput("成果物を進める", {
        stepsId: "歌",
        steps: "## いま取り組んでいること\n進捗:\n- いま: モチーフを3つ書き出す\n- まだ: Aメロの2行を書く\n- まだ: サビの2行を書く",
        currentTask: "モチーフを3つ書き出す",
      }),
    );
    const prompt = llm.calls[0].messages[1].content;
    expect(prompt).toContain("モチーフを3つ書き出す"); // current タスクは渡る
    expect(prompt).not.toContain("Aメロの2行を書く"); // 先のステップは渡さない
    expect(prompt).not.toContain("サビの2行を書く");
  });

  it("facts.body はそのターンで作った一片（全文ではない）", async () => {
    await writeNoteContent("works/新曲.md", "既にある一連目");
    const llm = new FakeLlmClient(["新しい二連目だけ"]);
    const outcome = await runSynthesize(llm, makeInput("続き", { stepsId: "新曲" }));
    if (outcome.attempted && outcome.status === "succeeded") {
      expect((outcome.facts as { body: string }).body).toBe("新しい二連目だけ");
    } else {
      throw new Error("expected success");
    }
  });
});
