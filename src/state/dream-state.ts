import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type DreamState = {
  lastDreamAt: string | null;
  /** 夢のタネ（seed）を蒸留済みの時刻。null なら未適用 */
  seedAppliedAt: string | null;
  factCount?: number;
  updatedAt: string;
};

export function defaultDreamStatePath(cwd = process.cwd()): string {
  return path.join(cwd, "data", "dream-state.json");
}

export function defaultDreamState(): DreamState {
  return {
    lastDreamAt: null,
    seedAppliedAt: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function loadDreamState(
  filePath: string,
): Promise<DreamState> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DreamState>;
    return {
      lastDreamAt:
        typeof parsed.lastDreamAt === "string" || parsed.lastDreamAt === null
          ? parsed.lastDreamAt
          : null,
      seedAppliedAt:
        typeof parsed.seedAppliedAt === "string" ||
        parsed.seedAppliedAt === null
          ? parsed.seedAppliedAt
          : null,
      factCount:
        typeof parsed.factCount === "number" ? parsed.factCount : undefined,
      updatedAt:
        typeof parsed.updatedAt === "string" && parsed.updatedAt.trim()
          ? parsed.updatedAt
          : new Date(0).toISOString(),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn("[dream-state] load failed, using defaults", err);
    }
  }
  return defaultDreamState();
}

export async function saveDreamState(
  filePath: string,
  state: Pick<DreamState, "lastDreamAt" | "seedAppliedAt" | "factCount">,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: DreamState = {
    lastDreamAt: state.lastDreamAt,
    seedAppliedAt: state.seedAppliedAt,
    factCount: state.factCount,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
