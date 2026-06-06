import { describe, expect, it } from "vitest";
import {
  InMemorySemanticStore,
  pseudoVector,
} from "../src/memory/semantic.js";

describe("InMemorySemanticStore", () => {
  it("upserts a new fact", async () => {
    const store = new InMemorySemanticStore();
    const fact = await store.upsert({
      body: "ユーザーは夏目漱石を好む",
      tags: ["読書"],
      sourceEpisodeIds: ["ep-1"],
    });
    expect(fact.body).toBe("ユーザーは夏目漱石を好む");
    expect(fact.confidence).toBe(1);
    expect(fact.tags).toEqual(["読書"]);
    expect(fact.sourceEpisodeIds).toEqual(["ep-1"]);
    expect(fact.deleted).toBe(false);
  });

  it("merges near-duplicate facts and reinforces confidence", async () => {
    const store = new InMemorySemanticStore();
    const body = "ユーザーは夏目漱石が好き";
    const vector = pseudoVector(body);
    const first = await store.upsert({
      body,
      vector,
      sourceEpisodeIds: ["ep-1"],
    });
    const second = await store.upsert({
      body: "ユーザーは夏目漱石を好む",
      vector,
      tags: ["文学"],
      sourceEpisodeIds: ["ep-2"],
    });
    expect(second.id).toBe(first.id);
    expect(second.confidence).toBe(2);
    expect(second.tags).toEqual(expect.arrayContaining(["文学"]));
    expect(second.sourceEpisodeIds).toEqual(
      expect.arrayContaining(["ep-1", "ep-2"]),
    );
    expect((await store.list()).length).toBe(1);
  });

  it("creates separate facts for distant vectors", async () => {
    const store = new InMemorySemanticStore();
    await store.upsert({ body: "ユーザーは夏目漱石を好む" });
    await store.upsert({ body: "明日は雨が降る" });
    expect((await store.list()).length).toBe(2);
  });

  it("recalls facts by query relevance", async () => {
    const store = new InMemorySemanticStore();
    await store.upsert({ body: "ユーザーは夏目漱石を好む" });
    await store.upsert({ body: "買い物リストに牛乳がある" });
    const hits = await store.recall("読書 夏目漱石", 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.body).toContain("夏目漱石");
  });

  it("soft-deletes a fact", async () => {
    const store = new InMemorySemanticStore();
    const fact = await store.upsert({ body: "テスト事実" });
    expect(await store.softDelete(fact.id)).toBe(true);
    expect(await store.list()).toHaveLength(0);
    expect(await store.softDelete("missing")).toBe(false);
  });
});
