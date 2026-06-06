import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "../src/tools/registry.js";

const NOTES_DIR = path.join(process.cwd(), "data", "notes");

describe("executeTool", () => {
  beforeEach(async () => {
    await mkdir(NOTES_DIR, { recursive: true });
  });

  afterEach(async () => {
    const testFile = path.join(NOTES_DIR, "test-note.txt");
    await rm(testFile, { force: true });
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
