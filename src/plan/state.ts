import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PLANS_DIR_DEFAULT = path.join(process.cwd(), "data", "plans");

/**
 * 構造化plan の保存先（真実の源）。markdown はここから派生レンダリングするビュー。
 * テスト隔離のため `PLANS_DIR` 環境変数で差し替え可能（既定 data/plans）。
 * notes.ts の `notesDir()`・paths.ts の `lancedbDir()` と同じ思想＝本物の記憶を汚さずに実機/テストを回す。
 */
export function plansDir(): string {
  return process.env.PLANS_DIR?.trim() || PLANS_DIR_DEFAULT;
}

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
  /** 進捗が無く見限った（卒業した）目標。集中の対象から外れ、自動復帰しない */
  retired?: boolean;
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
  return path.join(plansDir(), `${id}.json`);
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
  await mkdir(plansDir(), { recursive: true });
  await writeFile(
    planFilePath(state.id),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}
