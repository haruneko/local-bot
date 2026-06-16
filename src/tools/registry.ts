import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { safePath } from "./notes.js";
import path from "node:path";
import {
  notesDir,
  listNoteFilenames,
  normalizeReadArgs,
  normalizeWriteArgs,
  type ReadNoteArgs,
  type WriteNoteArgs,
} from "./notes.js";

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolResult = {
  ok: boolean;
  summary: string;
};

export async function listNotesSummary(): Promise<string> {
  const files = await listNoteFilenames();
  if (files.length === 0) return "（メモファイルはまだない）";
  return files.join(", ");
}

export async function executeTool(call: ToolCall): Promise<ToolResult> {
  await mkdir(notesDir(), { recursive: true });

  switch (call.name) {
    case "write_note": {
      const args = normalizeWriteArgs(call.arguments);
      if (!args) {
        return { ok: false, summary: "引数が不正だった（content が必要）" };
      }
      return writeNote(args);
    }
    case "read_note": {
      const args = normalizeReadArgs(call.arguments);
      if (!args) {
        return { ok: false, summary: "引数が不正だった（filename が必要）" };
      }
      return readNote(args);
    }
    case "list_notes": {
      const files = await listNoteFilenames();
      return {
        ok: true,
        summary:
          files.length === 0
            ? "メモはまだない"
            : `メモ一覧: ${files.join(", ")}`,
      };
    }
    default:
      return { ok: false, summary: `未知のツール: ${call.name}` };
  }
}

async function writeNote(args: WriteNoteArgs): Promise<ToolResult> {
  const safe = safePath(args.filename) ?? args.filename;
  const target = path.join(notesDir(), safe);
  await mkdir(path.dirname(target), { recursive: true });
  if (args.append) {
    try {
      await appendFile(target, `\n${args.content}`, "utf8");
      return { ok: true, summary: `メモ ${safe} に追記した` };
    } catch {
      await writeFile(target, args.content, "utf8");
      return { ok: true, summary: `メモ ${safe} を新規作成した` };
    }
  }
  await writeFile(target, args.content, "utf8");
  return { ok: true, summary: `メモ ${safe} を書き込んだ` };
}

async function readNote(args: ReadNoteArgs): Promise<ToolResult> {
  try {
    const text = await readFile(path.join(notesDir(), args.filename), "utf8");
    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    return { ok: true, summary: `メモ ${args.filename} を読んだ: ${preview}` };
  } catch {
    return { ok: false, summary: `メモ ${args.filename} が見つからなかった` };
  }
}
