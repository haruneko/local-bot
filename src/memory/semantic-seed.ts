import { readFile } from "node:fs/promises";
import path from "node:path";

/** 夢のタネ。内省風の断片（蒸留前の素材） */
export type SemanticSeedEntry = {
  body: string;
  tags?: string[];
};

export type SemanticSeedFile = {
  seed: SemanticSeedEntry[];
};

export function defaultSemanticSeedPath(cwd = process.cwd()): string {
  return path.join(cwd, "data", "semantic-seed.json");
}

function isSeedEntry(value: unknown): value is SemanticSeedEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as SemanticSeedEntry;
  return typeof e.body === "string" && e.body.trim().length > 0;
}

export function parseSemanticSeed(raw: unknown): SemanticSeedEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const parsed = raw as Partial<SemanticSeedFile> & { facts?: unknown };
  const items = parsed.seed ?? parsed.facts;
  if (!Array.isArray(items)) return [];
  return items.filter(isSeedEntry).map((e) => ({
    body: e.body.trim(),
    tags: Array.isArray(e.tags)
      ? e.tags.filter((t): t is string => typeof t === "string")
      : undefined,
  }));
}

export async function loadSemanticSeed(
  filePath: string = defaultSemanticSeedPath(),
): Promise<SemanticSeedEntry[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return parseSemanticSeed(JSON.parse(raw));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn("[semantic-seed] load failed, using empty seed", err);
    }
  }
  return [];
}
