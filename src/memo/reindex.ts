import type { MemoIndexStore } from "../memory/memo-index.js";
import {
  listNoteFilenames,
  readNoteContent,
  truncateNotePreview,
} from "../tools/notes.js";
import { INDEX_FILENAME } from "./tree.js";

/**
 * `data/notes/` を走査し、未索引も含め全メモを memo_index に upsert する。
 * recall 認識（locate の主経路）は memo_index にエントリが無いノートを見つけられないため、
 * 外部から注入された/過去に書かれたノートを索引化する前提整備。
 * - `_index.md`（機械生成の派生ビュー）と空ファイルは索引しない。
 * - upsert は path で冪等（再実行で preview/vector を更新するだけ）。
 * - 削除済みファイルの stale エントリは消さない（recall 側が実在確認で弾く）。
 */
export async function reindexNotes(
  memoIndex: MemoIndexStore,
): Promise<{ indexed: number; skipped: number }> {
  const files = await listNoteFilenames();
  const now = new Date().toISOString();
  let indexed = 0;
  let skipped = 0;
  for (const file of files) {
    if (file.endsWith(INDEX_FILENAME)) {
      skipped++;
      continue;
    }
    const content = await readNoteContent(file);
    if (content === null || !content.trim()) {
      skipped++;
      continue;
    }
    await memoIndex.upsert({
      path: file,
      preview: truncateNotePreview(content, 200),
      createdAt: now,
      updatedAt: now,
    });
    indexed++;
  }
  return { indexed, skipped };
}
