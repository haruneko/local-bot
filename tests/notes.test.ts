import { describe, expect, it } from "vitest";
import {
  normalizeWriteArgs,
  normalizeReadArgs,
  defaultNoteFilename,
  slugifyFilename,
  truncateNotePreview,
  formatNotePreviewIndex,
} from "../src/tools/notes.js";

describe("note args", () => {
  it("accepts body alias for content", () => {
    const args = normalizeWriteArgs({ body: "hello", file: "a.md" });
    expect(args?.content).toBe("hello");
    expect(args?.filename).toBe("a.md");
  });

  it("defaults filename when missing", () => {
    const args = normalizeWriteArgs({ content: "x" });
    expect(args?.filename).toMatch(/^note-\d{4}-\d{2}-\d{2}\.md$/);
  });

  it("slugifies unsafe filename", () => {
    expect(slugifyFilename("買い物/list")).toBe("買い物-list.md");
  });

  it("read normalizes file alias", () => {
    const args = normalizeReadArgs({ file: "test.md" });
    expect(args?.filename).toBe("test.md");
  });

  it("defaultNoteFilename format", () => {
    expect(defaultNoteFilename(new Date("2026-06-03"))).toBe(
      "note-2026-06-03.md",
    );
  });

  it("truncateNotePreview adds ellipsis when over limit", () => {
    const long = "あ".repeat(250);
    expect(truncateNotePreview(long, 200)).toBe(`${"あ".repeat(200)}…`);
  });

  it("formatNotePreviewIndex joins filename and preview", () => {
    const index = formatNotePreviewIndex([
      { filename: "a.md", preview: "買い物リスト" },
      { filename: "b.md", preview: "設計メモ" },
    ]);
    expect(index).toContain("a.md — 買い物リスト");
    expect(index).toContain("b.md — 設計メモ");
  });
});
