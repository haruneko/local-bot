import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

/** plan の一覧用サマリ（バインダーの目次）。plan actor が「どの計画を扱うか」を選ぶための入力。 */
export type PlanSummary = {
  id: string;
  title: string;
  goal: string;
  /** 全マイルストーン完了済み */
  done: boolean;
  /** 見限り済み（自動復帰しない） */
  retired: boolean;
  /** いま取り組む milestone の本文（なければ null） */
  current: string | null;
  completed: number;
  total: number;
  updatedAt: string;
};

/** plans ディレクトリの全 plan を読み、サマリ一覧を返す（新しい順）。無ければ空配列。 */
export async function listPlans(): Promise<PlanSummary[]> {
  let files: string[];
  try {
    files = (await readdir(plansDir())).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: PlanSummary[] = [];
  for (const f of files) {
    try {
      const p = JSON.parse(
        await readFile(path.join(plansDir(), f), "utf8"),
      ) as PlanState;
      const completed = p.milestones.filter((m) => m.done).length;
      const cur = p.milestones.find((m) => m.id === p.current);
      out.push({
        id: p.id,
        title: p.title,
        goal: p.goal,
        done: p.milestones.length > 0 && completed === p.milestones.length,
        retired: !!p.retired,
        current: cur?.text ?? null,
        completed,
        total: p.milestones.length,
        updatedAt: p.updatedAt,
      });
    } catch {
      // 壊れた JSON はスキップ
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}
