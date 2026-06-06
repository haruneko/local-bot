import { describe, expect, it } from "vitest";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";

function episode(
  turnId: string,
  body: string,
  timestamp: string,
) {
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

describe("EpisodeStore.listSince", () => {
  it("returns episodes after watermark in timestamp order", async () => {
    const store = new InMemoryEpisodeStore();
    await store.append(
      episode("t1", "最初の内省", "2026-06-01T10:00:00.000Z"),
    );
    await store.append(
      episode("t2", "二番目の内省", "2026-06-02T10:00:00.000Z"),
    );
    await store.append(
      episode("t3", "三番目の内省", "2026-06-03T10:00:00.000Z"),
    );

    const all = await store.listSince();
    expect(all.map((r) => r.metadata.turnId)).toEqual(["t1", "t2", "t3"]);

    const since = await store.listSince("2026-06-02T10:00:00.000Z");
    expect(since.map((r) => r.metadata.turnId)).toEqual(["t3"]);

    const limited = await store.listSince(undefined, 2);
    expect(limited.map((r) => r.metadata.turnId)).toEqual(["t1", "t2"]);
  });

  it("excludes soft-deleted episodes", async () => {
    const store = new InMemoryEpisodeStore();
    await store.append(
      episode("t1", "削除対象", "2026-06-01T10:00:00.000Z"),
    );
    await store.append(
      episode("t2", "残る", "2026-06-02T10:00:00.000Z"),
    );
    await store.softDelete("t1");
    const rows = await store.listSince();
    expect(rows.map((r) => r.metadata.turnId)).toEqual(["t2"]);
  });
});
