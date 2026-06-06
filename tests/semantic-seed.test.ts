import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSemanticSeed,
  parseSemanticSeed,
} from "../src/memory/semantic-seed.js";

describe("semantic-seed", () => {
  it("parses seed entries (内省風の断片)", () => {
    const entries = parseSemanticSeed({
      seed: [
        { body: "  わたしはこの家で暮らす  ", tags: ["core"] },
        { body: "" },
        { body: "少しずつ育っていく" },
      ],
    });
    expect(entries).toEqual([
      { body: "わたしはこの家で暮らす", tags: ["core"] },
      { body: "少しずつ育っていく", tags: undefined },
    ]);
  });

  it("loads seed file from disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-seed-"));
    const file = path.join(dir, "semantic-seed.json");
    try {
      await writeFile(
        file,
        JSON.stringify({
          seed: [{ body: "夢のタネ断片", tags: ["seed"] }],
        }),
        "utf8",
      );
      expect(await loadSemanticSeed(file)).toEqual([
        { body: "夢のタネ断片", tags: ["seed"] },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns empty list when file is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-seed-"));
    const file = path.join(dir, "missing.json");
    try {
      expect(await loadSemanticSeed(file)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
