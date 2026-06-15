import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import { InMemorySemanticStore } from "../src/memory/semantic.js";
import { InMemoryMemoIndexStore } from "../src/memory/memo-index.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { runDream } from "../src/roles/dream.js";
import { loadDreamState } from "../src/state/dream-state.js";

function episode(turnId: string, body: string, timestamp: string) {
  return {
    body,
    metadata: {
      timestamp,
      participants: [],
      tags: [],
      state: "対話",
      action: "",
      source: "introspection" as const,
      reply: true,
      turnId,
    },
  };
}

describe("runDream", () => {
  it("符号化ロンダリング対策: 本文でなく裏打ち事実(groundedFacts)から蒸留する", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-dream-gf-"));
    const dreamStatePath = path.join(dir, "dream-state.json");
    const episodes = new InMemoryEpisodeStore();
    await episodes.append({
      body: "冷蔵庫を確認した（作話）。とても満ち足りた気分だった。",
      metadata: {
        timestamp: "2026-06-01T10:00:00.000Z",
        participants: [],
        tags: [],
        state: "対話",
        action: "",
        source: "introspection" as const,
        reply: true,
        turnId: "t1",
        groundedFacts:
          "太郎: 買い物リスト何だっけ？\n\n買い物リスト.md を読んだ: 卵・牛乳・パン",
      },
    });
    const llm = new FakeLlmClient([
      JSON.stringify({
        facts: [{ body: "太郎の買い物リストは卵・牛乳・パン", tags: ["買い物"] }],
      }),
    ]);

    await runDream({
      llm,
      episodes,
      semantic: new InMemorySemanticStore(),
      dreamStatePath,
      minEpisodes: 1,
    });

    const userContent = llm.calls[0]!.messages.find(
      (m) => m.role === "user",
    )!.content;
    expect(userContent).toContain("買い物リスト.md を読んだ"); // 裏打ち事実から蒸留
    expect(userContent).not.toContain("冷蔵庫を確認した"); // 作話本文は使わない

    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("memo_index 同期: distill 実行時に未登録メモ(data/notes)を取り込む", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-dream-mi-"));
    const dreamStatePath = path.join(dir, "dream-state.json");
    const notes = path.join(dir, "notes");
    await mkdir(notes, { recursive: true });
    await writeFile(path.join(notes, "memo-a.md"), "# メモA\n中身がある");
    const prev = process.env.MEMO_NOTES_DIR;
    process.env.MEMO_NOTES_DIR = notes;
    try {
      const episodes = new InMemoryEpisodeStore();
      await episodes.append(
        episode("t1", "ユーザーが話した", "2026-06-01T10:00:00.000Z"),
      );
      const memoIndex = new InMemoryMemoIndexStore();
      const llm = new FakeLlmClient([
        JSON.stringify({ facts: [{ body: "x", tags: [] }] }),
      ]);

      const result = await runDream({
        llm,
        episodes,
        semantic: new InMemorySemanticStore(),
        memoIndex,
        dreamStatePath,
        minEpisodes: 1,
      });

      expect(result.memoIndexSynced).toBe(1);
      const indexed = await memoIndex.list();
      expect(indexed.some((e) => e.path === "memo-a.md")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MEMO_NOTES_DIR;
      else process.env.MEMO_NOTES_DIR = prev;
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("skips when episodes are below minimum and no seed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-dream-run-"));
    const dreamStatePath = path.join(dir, "dream-state.json");
    const episodes = new InMemoryEpisodeStore();
    await episodes.append(
      episode("t1", "ユーザーが読書の話をした", "2026-06-01T10:00:00.000Z"),
    );
    const llm = new FakeLlmClient([]);

    const result = await runDream({
      llm,
      episodes,
      semantic: new InMemorySemanticStore(),
      dreamStatePath,
      minEpisodes: 3,
    });

    expect(result.ran).toBe(false);
    expect(result.skippedReason).toContain("episodes 1 < min 3");
    expect(llm.calls).toHaveLength(0);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("distills seed only on first run without episodes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-dream-run-"));
    const dreamStatePath = path.join(dir, "dream-state.json");
    const semantic = new InMemorySemanticStore();
    const now = new Date("2026-06-06T12:00:00.000Z");
    const llm = new FakeLlmClient([
      JSON.stringify({
        facts: [{ body: "わたしは自宅で暮らす自律的な存在である", tags: ["自己"] }],
      }),
    ]);

    const result = await runDream({
      llm,
      episodes: new InMemoryEpisodeStore(),
      semantic,
      dreamStatePath,
      minEpisodes: 3,
      seed: [{ body: "わたしはこの家で動く存在だと感じている", tags: ["core"] }],
      applySeed: true,
      now,
    });

    expect(result.ran).toBe(true);
    expect(result.episodesProcessed).toBe(0);
    expect(result.seedProcessed).toBe(1);
    expect(result.factsUpserted).toBe(1);
    expect(result.seedAppliedAt).toBe(now.toISOString());

    const state = await loadDreamState(dreamStatePath);
    expect(state.seedAppliedAt).toBe(now.toISOString());
    expect((await semantic.list())[0]!.body).toContain("自律的");

    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("retries when first LLM response has broken JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-dream-run-"));
    const dreamStatePath = path.join(dir, "dream-state.json");
    const semantic = new InMemorySemanticStore();
    const broken = '{"facts":[{"body":"壊れ"';
    const fixed = JSON.stringify({
      facts: [{ body: "修復後の知識" }],
    });
    const llm = new FakeLlmClient([broken, fixed]);

    const result = await runDream({
      llm,
      episodes: new InMemoryEpisodeStore(),
      semantic,
      dreamStatePath,
      seed: [{ body: "タネ" }],
      applySeed: true,
    });

    expect(result.ran).toBe(true);
    expect(llm.calls).toHaveLength(2);
    expect((await semantic.list())[0]!.body).toBe("修復後の知識");
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("does not re-apply seed without --force-seed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-dream-run-"));
    const dreamStatePath = path.join(dir, "dream-state.json");
    const semantic = new InMemorySemanticStore();
    const firstNow = new Date("2026-06-06T12:00:00.000Z");
    const llm1 = new FakeLlmClient([
      JSON.stringify({ facts: [{ body: "最初の知識" }] }),
    ]);
    await runDream({
      llm: llm1,
      episodes: new InMemoryEpisodeStore(),
      semantic,
      dreamStatePath,
      seed: [{ body: "タネ" }],
      applySeed: true,
      now: firstNow,
    });

    const llm2 = new FakeLlmClient([]);
    const second = await runDream({
      llm: llm2,
      episodes: new InMemoryEpisodeStore(),
      semantic,
      dreamStatePath,
      seed: [{ body: "タネ" }],
      applySeed: true,
    });

    expect(second.ran).toBe(false);
    expect(llm2.calls).toHaveLength(0);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("distills episodes into semantic facts and advances watermark", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-dream-run-"));
    const dreamStatePath = path.join(dir, "dream-state.json");
    const episodes = new InMemoryEpisodeStore();
    const semantic = new InMemorySemanticStore();
    const now = new Date("2026-06-06T12:00:00.000Z");

    for (const [id, ts] of [
      ["t1", "2026-06-01T10:00:00.000Z"],
      ["t2", "2026-06-02T10:00:00.000Z"],
      ["t3", "2026-06-03T10:00:00.000Z"],
    ] as const) {
      await episodes.append(
        episode(id, `ユーザーが夏目漱石の話をした (${id})`, ts),
      );
    }

    const llm = new FakeLlmClient([
      JSON.stringify({
        facts: [
          { body: "ユーザーは夏目漱石を好む", tags: ["読書"] },
        ],
      }),
    ]);

    const result = await runDream({
      llm,
      episodes,
      semantic,
      dreamStatePath,
      minEpisodes: 3,
      now,
    });

    expect(result.ran).toBe(true);
    expect(result.episodesProcessed).toBe(3);
    expect(result.factsUpserted).toBe(1);
    expect(result.lastDreamAt).toBe(now.toISOString());

    const facts = await semantic.list();
    expect(facts).toHaveLength(1);
    expect(facts[0]!.body).toBe("ユーザーは夏目漱石を好む");

    const state = await loadDreamState(dreamStatePath);
    expect(state.lastDreamAt).toBe(now.toISOString());
    expect(state.factCount).toBe(1);

    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("processes only episodes after watermark on second run", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-dream-run-"));
    const dreamStatePath = path.join(dir, "dream-state.json");
    const episodes = new InMemoryEpisodeStore();
    const semantic = new InMemorySemanticStore();

    for (const [id, ts] of [
      ["t1", "2026-06-01T10:00:00.000Z"],
      ["t2", "2026-06-02T10:00:00.000Z"],
      ["t3", "2026-06-03T10:00:00.000Z"],
      ["t4", "2026-06-04T10:00:00.000Z"],
      ["t5", "2026-06-05T10:00:00.000Z"],
    ] as const) {
      await episodes.append(episode(id, `内省 ${id}`, ts));
    }

    const firstNow = new Date("2026-06-04T00:00:00.000Z");
    const llm1 = new FakeLlmClient([
      JSON.stringify({ facts: [{ body: "最初の知識" }] }),
    ]);
    await runDream({
      llm: llm1,
      episodes,
      semantic,
      dreamStatePath,
      minEpisodes: 3,
      now: firstNow,
    });

    const llm2 = new FakeLlmClient([
      JSON.stringify({ facts: [{ body: "追加の知識" }] }),
    ]);
    const second = await runDream({
      llm: llm2,
      episodes,
      semantic,
      dreamStatePath,
      minEpisodes: 3,
      now: new Date("2026-06-06T00:00:00.000Z"),
    });

    expect(second.ran).toBe(false);
    expect(second.skippedReason).toContain("episodes 2 < min 3");
    expect(llm2.calls).toHaveLength(0);
    expect((await semantic.list()).map((f) => f.body)).toEqual(["最初の知識"]);

    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});
