import { describe, expect, it } from "vitest";
import {
  InMemoryMemoIndexStore,
} from "../src/memory/memo-index.js";

describe("InMemoryMemoIndexStore", () => {
  it("upsert して list で取得できる", async () => {
    const store = new InMemoryMemoIndexStore();
    await store.upsert({
      path: "買い物リスト.md",
      preview: "卵、牛乳、パン",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe("買い物リスト.md");
    expect(list[0].preview).toBe("卵、牛乳、パン");
  });

  it("同一 path を upsert すると上書き（1件のまま）", async () => {
    const store = new InMemoryMemoIndexStore();
    await store.upsert({
      path: "memo.md",
      preview: "初回",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.upsert({
      path: "memo.md",
      preview: "更新後",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].preview).toBe("更新後");
  });

  it("recall が距離順で返る", async () => {
    const store = new InMemoryMemoIndexStore();
    await store.upsert({
      path: "food.md",
      preview: "卵、牛乳、パン、食材リスト",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.upsert({
      path: "music.md",
      preview: "SoundHorizon の歌詞まとめ",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const hits = await store.recall("食材 買い物", 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].distance).toBeLessThanOrEqual(hits[1].distance);
  });

  it("topK でヒット数を制限する", async () => {
    const store = new InMemoryMemoIndexStore();
    for (let i = 0; i < 5; i++) {
      await store.upsert({
        path: `note-${i}.md`,
        preview: `メモ ${i}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    }
    const hits = await store.recall("メモ", 3);
    expect(hits).toHaveLength(3);
  });
});
