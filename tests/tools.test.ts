import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "../src/tools/registry.js";

// 本物の data/notes/ を汚さないよう temp ディレクトリへ隔離する（notesDir() が MEMO_NOTES_DIR を優先）。
let dir: string;
describe("executeTool", () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tools-"));
    process.env.MEMO_NOTES_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.MEMO_NOTES_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("write_note and read_note work", async () => {
    const write = await executeTool({
      name: "write_note",
      arguments: { filename: "test-note.txt", content: "hello" },
    });
    expect(write.ok).toBe(true);

    const read = await executeTool({
      name: "read_note",
      arguments: { filename: "test-note.txt" },
    });
    expect(read.ok).toBe(true);
    expect(read.summary).toContain("hello");
  });

  it("rejects path traversal via slugify fallback", async () => {
    const result = await executeTool({
      name: "write_note",
      arguments: { filename: "../escape.txt", content: "x" },
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("escape.txt");
  });

  it("accepts body alias", async () => {
    const result = await executeTool({
      name: "write_note",
      arguments: { file: "alias-test.md", body: "from body" },
    });
    expect(result.ok).toBe(true);
  });
});
