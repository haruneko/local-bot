import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  deleteNote,
  notesDir,
  readNoteContent,
  slugifyFilename,
  writeNoteContent,
} from "../tools/notes.js";

/** 各フォルダの目次（MOC）ファイル名。機械生成の派生ビュー（真実は葉の本文） */
export const INDEX_FILENAME = "_index.md";

/** markdown 見出し行（# 〜 ######）を抜き出す。本文は読まない（所在の地図用） */
export function extractHeadings(content: string): string[] {
  return content
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => l.trim());
}

export type DirChild = { path: string; name: string };
export type LeafChild = { path: string; name: string; headings: string[] };

/**
 * dirRel 直下の子（サブフォルダと葉メモ）を列挙する。_index.md とドットファイルは除外。
 * descent はこの関数で**ファイルシステムを直接**たどる（生成された _index.md はパースしない）。
 */
export async function listChildren(
  dirRel: string,
): Promise<{ dirs: DirChild[]; leaves: LeafChild[] }> {
  const abs = path.join(notesDir(), dirRel);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return { dirs: [], leaves: [] };
  }
  const dirs: DirChild[] = [];
  const leaves: LeafChild[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      dirs.push({ path: rel, name: e.name });
    } else if (e.isFile() && e.name.endsWith(".md") && e.name !== INDEX_FILENAME) {
      let content = "";
      try {
        content = await readFile(path.join(abs, e.name), "utf8");
      } catch {
        /* 読めなければ見出し無しで扱う */
      }
      leaves.push({ path: rel, name: e.name, headings: extractHeadings(content) });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  leaves.sort((a, b) => a.name.localeCompare(b.name));
  return { dirs, leaves };
}

/** 拡張子 .md を落とした wikilink ターゲット */
function linkTarget(rel: string): string {
  return rel.replace(/\.md$/, "");
}

/**
 * dirRel の `_index.md`（MOC）を子の列挙から機械再生成する。LLM を呼ばない・要約しない。
 * plan の json→markdown と同じ「真実 vs 派生ビュー」。Obsidian で目次として開ける。
 */
export async function regenerateIndex(dirRel: string): Promise<void> {
  const { dirs, leaves } = await listChildren(dirRel);
  const title = dirRel ? path.basename(dirRel) : "notes";
  const lines = [`# ${title}`, ""];
  if (dirs.length === 0 && leaves.length === 0) {
    lines.push("（空）");
  }
  for (const d of dirs) {
    lines.push(`- [[${linkTarget(d.path)}/${INDEX_FILENAME.replace(/\.md$/, "")}]]`);
  }
  for (const l of leaves) {
    const h = l.headings.length ? `  ${l.headings.join(" / ")}` : "";
    lines.push(`- [[${linkTarget(l.path)}]]${h}`);
  }
  await writeNoteContent(path.join(dirRel, INDEX_FILENAME), `${lines.join("\n")}\n`);
}

// --- サイズ自動分割（docs/MEMO-TREE.md §段階4） ---

/** 葉メモの分割閾値（バイト）。テスト用に `MEMO_MAX_LEAF_BYTES` で差し替え可能 */
export const DEFAULT_MAX_LEAF_BYTES = 8000;
export function maxLeafBytes(): number {
  const env = Number(process.env.MEMO_MAX_LEAF_BYTES);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_LEAF_BYTES;
}

function headingLevel(line: string): number {
  const m = /^(#{1,6})\s/.exec(line);
  return m ? m[1].length : 0;
}

type Section = { heading: string | null; text: string };

/** 本文を最浅レベルの見出し境界でセクションに分ける（見出し行はセクションに含む・verbatim） */
function splitIntoSections(content: string): Section[] {
  const lines = content.split("\n");
  const levels = lines.map(headingLevel).filter((l) => l > 0);
  if (levels.length === 0) return [{ heading: null, text: content }];
  const minLevel = Math.min(...levels);
  const sections: Section[] = [];
  let cur: { heading: string | null; lines: string[] } = { heading: null, lines: [] };
  const flush = () => {
    if (cur.lines.length || cur.heading !== null) {
      sections.push({ heading: cur.heading, text: cur.lines.join("\n") });
    }
  };
  for (const line of lines) {
    const lv = headingLevel(line);
    if (lv > 0 && lv <= minLevel) {
      flush();
      cur = { heading: line.trim(), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  flush();
  return sections.filter((s) => s.text.trim().length > 0);
}

/** セクションを予算以下のチャンクへ貪欲に詰める（1チャンク最低1セクション・セクションは割らない） */
function groupByBudget(sections: Section[], maxBytes: number): Section[] {
  const chunks: Section[] = [];
  let curText: string[] = [];
  let curHeading: string | null = null;
  let curBytes = 0;
  for (const s of sections) {
    const b = Buffer.byteLength(s.text, "utf8");
    if (curText.length > 0 && curBytes + b > maxBytes) {
      chunks.push({ heading: curHeading, text: curText.join("\n\n") });
      curText = [];
      curBytes = 0;
      curHeading = null;
    }
    if (curText.length === 0) curHeading = s.heading;
    curText.push(s.text);
    curBytes += b;
  }
  if (curText.length) chunks.push({ heading: curHeading, text: curText.join("\n\n") });
  return chunks;
}

function chunkSlug(heading: string | null, ord: string): string {
  if (!heading) return `part-${ord}`;
  const text = heading.replace(/^#+\s*/, "").trim();
  const slug = slugifyFilename(text).replace(/\.md$/, "");
  return slug || `part-${ord}`;
}

export type SplitResult = { folder: string; children: string[] };

/**
 * 葉メモが予算を超えていたら、見出し境界で機械分割し同名フォルダ化する（LLM 不要・verbatim）。
 *  `dir/lyrics.md` → `dir/lyrics/01-<slug>.md`, `02-...` …。元ファイルは削除。
 * 分割したら {folder, children} を返す。不要・分割不能（見出し無しの巨大ベタ書き）なら null。
 */
export async function splitIfOversized(
  fileRel: string,
  maxBytes = maxLeafBytes(),
): Promise<SplitResult | null> {
  const content = await readNoteContent(fileRel);
  if (content === null) return null;
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return null;

  const sections = splitIntoSections(content);
  if (sections.length <= 1) return null; // 見出し無しの巨大ベタ書き → 分割不能（将来: byte paging）

  const chunks = groupByBudget(sections, maxBytes);
  if (chunks.length <= 1) return null;

  const folder = fileRel.replace(/\.md$/, "");
  const children: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const ord = String(i + 1).padStart(2, "0");
    const slug = chunkSlug(chunks[i].heading, ord);
    const childRel = `${folder}/${ord}-${slug}.md`;
    await writeNoteContent(childRel, `${chunks[i].text.replace(/\s*$/, "")}\n`);
    children.push(childRel);
  }
  await deleteNote(fileRel);
  return { folder, children };
}

/** fileRel の親フォルダからルートまでの `_index.md` を再生成する（新フォルダも上位目次に出る） */
export async function regenerateIndexChain(fileRel: string): Promise<void> {
  let dir = path.dirname(fileRel);
  if (dir === ".") dir = "";
  const chain: string[] = [];
  while (true) {
    chain.push(dir);
    if (!dir) break;
    dir = path.dirname(dir);
    if (dir === ".") dir = "";
  }
  for (const d of chain) {
    await regenerateIndex(d);
  }
}
