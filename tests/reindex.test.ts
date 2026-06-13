import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reindexNotes } from "../src/memo/reindex.js";
import { InMemoryMemoIndexStore } from "../src/memory/memo-index.js";
import { writeNoteContent } from "../src/tools/notes.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "reindex-"));
  process.env.MEMO_NOTES_DIR = dir;
});
afterEach(async () => {
  delete process.env.MEMO_NOTES_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("reindexNotes", () => {
  it("全メモを memo_index に索引し、_index.md と空ファイルはスキップ", async () => {
    await writeNoteContent("買い物リスト.md", "卵\n牛乳");
    await writeNoteContent("lyrics/01-新曲.md", "## サビ\nうた");
    await writeNoteContent("_index.md", "# notes\n- [[買い物リスト]]"); // 派生ビュー
    await writeNoteContent("空.md", "   "); // 空白のみ

    const memoIndex = new InMemoryMemoIndexStore();
    const { indexed, skipped } = await reindexNotes(memoIndex);

    expect(indexed).toBe(2); // 買い物リスト + lyrics/01-新曲
    expect(skipped).toBe(2); // _index.md + 空.md
    const paths = (await memoIndex.list()).map((e) => e.path).sort();
    expect(paths).toEqual(["lyrics/01-新曲.md", "買い物リスト.md"]);
  });

  it("索引後に recall で既存ノートを引ける（recall認識の前提）", async () => {
    await writeNoteContent("inventory/fridge.md", "牛乳\nパン");
    const memoIndex = new InMemoryMemoIndexStore();
    await reindexNotes(memoIndex);
    const hits = await memoIndex.recall("冷蔵庫の在庫", 5);
    expect(hits.some((h) => h.path === "inventory/fridge.md")).toBe(true);
  });

  it("冪等（再実行で重複しない）", async () => {
    await writeNoteContent("a.md", "x");
    const memoIndex = new InMemoryMemoIndexStore();
    await reindexNotes(memoIndex);
    await reindexNotes(memoIndex);
    expect(await memoIndex.list()).toHaveLength(1);
  });
});
