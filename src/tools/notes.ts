import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { platform } from "node:process";

export const NOTES_DIR = path.join(process.cwd(), "data", "notes");

/** メモの保存先ルート。テスト隔離のため `MEMO_NOTES_DIR` で差し替え可能（既定は data/notes） */
export function notesDir(): string {
  return process.env.MEMO_NOTES_DIR?.trim() || NOTES_DIR;
}

export type WriteNoteArgs = {
  filename: string;
  content: string;
  append?: boolean;
};

export type ReadNoteArgs = {
  filename: string;
};

export function defaultNoteFilename(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `note-${y}-${m}-${d}.md`;
}

export function slugifyFilename(name: string): string {
  const base = name
    .trim()
    .replace(/[^\w\u3040-\u30ff\u4e00-\u9fff.-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const stem = base || "memo";
  return stem.endsWith(".md") ? stem : `${stem}.md`;
}

export function safeFilename(name: string): string | null {
  const trimmed = name.trim();
  const base = path.basename(trimmed);
  if (!base || base !== trimmed.replace(/[/\\]/g, "") || base.includes("..")) {
    return null;
  }
  return base;
}

/**
 * サブディレクトリを含む相対パスを検証する。
 * NOTES_DIR の外に出るパス（.. 等）は null を返す。
 */
export function safePath(p: string): string | null {
  const trimmed = p.trim();
  if (!trimmed) return null;
  // Windows パス区切り統一
  const normalized = path.normalize(trimmed).split(path.sep).join("/");
  if (
    path.isAbsolute(normalized) ||
    normalized.startsWith("..") ||
    normalized.includes("/../") ||
    (platform === "win32" && /^[a-zA-Z]:/.test(normalized))
  ) {
    return null;
  }
  return normalized;
}

export function ensureMdExtension(filename: string): string {
  return filename.endsWith(".md") ? filename : `${filename}.md`;
}

export function pickString(
  args: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export function normalizeWriteArgs(
  raw: Record<string, unknown>,
  fallbackContent?: string,
): WriteNoteArgs | null {
  const content =
    pickString(raw, ["content", "body", "text", "note", "message"]) ??
    fallbackContent?.trim();
  if (!content) return null;

  let filename =
    pickString(raw, ["filename", "file", "name", "path"]) ??
    defaultNoteFilename();
  filename = ensureMdExtension(filename);
  let safe = safeFilename(filename);
  if (!safe) safe = slugifyFilename(filename);

  const append =
    raw.append === true ||
    pickString(raw, ["mode"]) === "append" ||
    raw.append === "true";

  return { filename: safe, content, append: append || undefined };
}

export function normalizeReadArgs(
  raw: Record<string, unknown>,
): ReadNoteArgs | null {
  const filename = pickString(raw, ["filename", "file", "name", "path"]);
  if (!filename) return null;
  const withMd = ensureMdExtension(filename);
  const safe = safeFilename(withMd) ?? slugifyFilename(withMd);
  return { filename: safe };
}

export async function readNoteContent(filename: string): Promise<string | null> {
  const safe = safePath(filename) ?? safeFilename(filename) ?? slugifyFilename(filename);
  try {
    return await readFile(path.join(notesDir(), safe), "utf8");
  } catch {
    return null;
  }
}

/**
 * メモ本文を全文で書き込む（サブディレクトリ保全・親フォルダ自動作成）。
 * op 純関数 applier が計算した nextContent をそのまま書く用途。成功時は実際に書いた相対パスを返す。
 * normalizeWriteArgs と違いサブディレクトリを平坦化しない（メモの木のため）。
 */
export async function writeNoteContent(
  filename: string,
  content: string,
): Promise<string | null> {
  const safe = safePath(filename) ?? safeFilename(filename) ?? slugifyFilename(filename);
  if (!safe) return null;
  const target = path.join(notesDir(), safe);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return safe;
  } catch {
    return null;
  }
}

/** メモファイルを削除する（分割で元ファイルをフォルダ化するとき等）。パス安全処理あり */
export async function deleteNote(filename: string): Promise<void> {
  const safe = safePath(filename) ?? safeFilename(filename) ?? slugifyFilename(filename);
  if (!safe) return;
  try {
    await rm(path.join(notesDir(), safe), { force: true });
  } catch {
    /* 無ければ何もしない */
  }
}

export const NOTE_PREVIEW_LENGTH = 200;

export type NotePreview = {
  filename: string;
  preview: string;
};

export function truncateNotePreview(
  text: string,
  max = NOTE_PREVIEW_LENGTH,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

export async function listNoteFilenames(): Promise<string[]> {
  const root = notesDir();
  try {
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => {
        const fullPath = path.join(
          (e as unknown as { parentPath?: string; path?: string }).parentPath ??
            (e as unknown as { path?: string }).path ??
            root,
          e.name,
        );
        return path.relative(root, fullPath).split(path.sep).join("/");
      })
      .sort();
  } catch {
    return [];
  }
}

export async function listNotePreviews(
  maxPreviewLength = NOTE_PREVIEW_LENGTH,
): Promise<NotePreview[]> {
  const files = await listNoteFilenames();
  const previews: NotePreview[] = [];
  for (const filename of files) {
    const content = await readNoteContent(filename);
    previews.push({
      filename,
      preview: content
        ? truncateNotePreview(content, maxPreviewLength)
        : "（空）",
    });
  }
  return previews;
}

export function formatNotePreviewIndex(previews: NotePreview[]): string {
  if (previews.length === 0) return "（メモファイルはまだない）";
  return previews
    .map((p) => `${p.filename} — ${p.preview}`)
    .join("\n");
}
