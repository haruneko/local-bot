import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** 構造化plan の保存先（真実の源）。markdown はここから派生レンダリングするビュー */
export const PLANS_DIR = path.join(process.cwd(), "data", "plans");

export type Milestone = { id: string; text: string; done: boolean };
export type PlanLogEntry = { date: string; text: string };

export type PlanState = {
  id: string;
  title: string;
  goal: string;
  milestones: Milestone[];
  /** いま取り組んでいる milestone id（なければ null） */
  current: string | null;
  /** 起きた事実の追記ログ（過去形） */
  log: PlanLogEntry[];
  createdAt: string;
  updatedAt: string;
};

/** タイトルから plan id（ファイル名スラグ）を作る。日本語はそのまま残す */
export function planSlug(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^\w぀-ヿ一-鿿]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "plan";
}

function planFilePath(id: string): string {
  return path.join(PLANS_DIR, `${id}.json`);
}

export async function loadPlan(id: string): Promise<PlanState | null> {
  if (!id) return null;
  try {
    const raw = await readFile(planFilePath(id), "utf8");
    return JSON.parse(raw) as PlanState;
  } catch {
    return null;
  }
}

export async function savePlan(state: PlanState): Promise<void> {
  await mkdir(PLANS_DIR, { recursive: true });
  await writeFile(
    planFilePath(state.id),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}
