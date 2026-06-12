import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listChildren,
  extractHeadings,
  regenerateIndex,
  regenerateIndexChain,
  splitIfOversized,
} from "../src/memo/tree.js";
import { readNoteContent, writeNoteContent } from "../src/tools/notes.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "memo-tree-"));
  process.env.MEMO_NOTES_DIR = dir;
});
afterEach(async () => {
  delete process.env.MEMO_NOTES_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("extractHeadings", () => {
  it("見出し行だけ抜く", () => {
    expect(extractHeadings("# A\n本文\n## B\nx\n### C")).toEqual(["# A", "## B", "### C"]);
  });
});

describe("listChildren", () => {
  it("サブフォルダと葉を分け、_index.md とドットは除外", async () => {
    await writeNoteContent("note.md", "## 見出し\n本文");
    await writeNoteContent("lyrics/01.md", "歌詞");
    await writeNoteContent("_index.md", "目次");
    const { dirs, leaves } = await listChildren("");
    expect(dirs.map((d) => d.name)).toEqual(["lyrics"]);
    expect(leaves.map((l) => l.name)).toEqual(["note.md"]); // _index.md 除外
    expect(leaves[0].headings).toEqual(["## 見出し"]);
  });
});

describe("regenerateIndex / Chain", () => {
  it("子の列挙から _index.md を機械生成する", async () => {
    await writeNoteContent("lyrics/01-新曲.md", "## サビ\nうた");
    await writeNoteContent("lyrics/02-没.md", "ボツ");
    await regenerateIndex("lyrics");
    const idx = await readFile(path.join(dir, "lyrics", "_index.md"), "utf8");
    expect(idx).toContain("# lyrics");
    expect(idx).toContain("[[lyrics/01-新曲]]");
    expect(idx).toContain("## サビ"); // 見出しが目次に出る
    expect(idx).toContain("[[lyrics/02-没]]");
  });

  it("Chain は親〜ルートまで再生成し、フォルダが上位目次に出る", async () => {
    await writeNoteContent("lyrics/01.md", "x");
    await regenerateIndexChain("lyrics/01.md");
    const root = await readFile(path.join(dir, "_index.md"), "utf8");
    expect(root).toContain("[[lyrics/_index]]"); // ルート目次にフォルダが出る
    const sub = await readFile(path.join(dir, "lyrics", "_index.md"), "utf8");
    expect(sub).toContain("[[lyrics/01]]");
  });
});

describe("splitIfOversized", () => {
  const big = (label: string) => `${label}の本文`.repeat(20); // 各セクションを膨らませる
  const doc = ["## サビ", big("サビ"), "## Aメロ", big("Aメロ"), "## Bメロ", big("Bメロ")].join("\n");

  it("予算超過を見出し境界でフォルダ化し、元ファイルを消し、verbatim保全", async () => {
    await writeNoteContent("lyrics.md", doc);
    const res = await splitIfOversized("lyrics.md", 200); // 小さい予算
    expect(res).not.toBeNull();
    if (!res) throw new Error("expected split");
    expect(res.folder).toBe("lyrics");
    expect(res.children.length).toBeGreaterThan(1);
    // 元ファイルは消える
    expect(await readNoteContent("lyrics.md")).toBeNull();
    // 子は verbatim（見出し＋本文がそのまま）
    const joined = (await Promise.all(res.children.map((c) => readNoteContent(c)))).join("\n");
    expect(joined).toContain("## サビ");
    expect(joined).toContain(big("Aメロ"));
    // 子ファイル名は見出しスラグ＋連番
    expect(res.children[0]).toMatch(/^lyrics\/01-/);
  });

  it("予算内なら分割しない（null）", async () => {
    await writeNoteContent("small.md", "## A\n短い");
    expect(await splitIfOversized("small.md", 8000)).toBeNull();
  });

  it("見出し無しの巨大ベタ書きは分割不能（null・将来 byte paging）", async () => {
    await writeNoteContent("flat.md", "あ".repeat(500));
    expect(await splitIfOversized("flat.md", 200)).toBeNull();
  });
});
