import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const STEPS_DIR_DEFAULT = path.join(process.cwd(), "data", "steps");

/**
 * 構造化steps の保存先（真実の源）。markdown はここから派生レンダリングするビュー。
 * テスト隔離のため `STEPS_DIR` 環境変数で差し替え可能（既定 data/steps）。
 * notes.ts の `notesDir()`・paths.ts の `lancedbDir()` と同じ思想＝本物の記憶を汚さずに実機/テストを回す。
 */
export function stepsDir(): string {
  return process.env.STEPS_DIR?.trim() || STEPS_DIR_DEFAULT;
}

export type Milestone = { id: string; text: string; done: boolean };
export type StepsLogEntry = { date: string; text: string };

export type StepsState = {
  id: string;
  title: string;
  goal: string;
  milestones: Milestone[];
  /** いま取り組んでいる milestone id（なければ null） */
  current: string | null;
  /** 起きた事実の追記ログ（過去形） */
  log: StepsLogEntry[];
  /** 進捗が無く見限った（卒業した）目標。集中の対象から外れ、自動復帰しない */
  retired?: boolean;
  createdAt: string;
  updatedAt: string;
};

/** タイトルから steps id（ファイル名スラグ）を作る。日本語はそのまま残す */
export function stepsSlug(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^\w぀-ヿ一-鿿]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "steps";
}

function stepsFilePath(id: string): string {
  return path.join(stepsDir(), `${id}.json`);
}

export async function loadSteps(id: string): Promise<StepsState | null> {
  if (!id) return null;
  try {
    const raw = await readFile(stepsFilePath(id), "utf8");
    return JSON.parse(raw) as StepsState;
  } catch {
    return null;
  }
}

export async function saveSteps(state: StepsState): Promise<void> {
  await mkdir(stepsDir(), { recursive: true });
  await writeFile(
    stepsFilePath(state.id),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

/** steps の一覧用サマリ（バインダーの目次）。steps actor が「どの計画を扱うか」を選ぶための入力。 */
export type StepsSummary = {
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

/** steps ディレクトリの全 steps を読み、サマリ一覧を返す（新しい順）。無ければ空配列。 */
export async function listSteps(): Promise<StepsSummary[]> {
  let files: string[];
  try {
    files = (await readdir(stepsDir())).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: StepsSummary[] = [];
  for (const f of files) {
    try {
      const p = JSON.parse(
        await readFile(path.join(stepsDir(), f), "utf8"),
      ) as StepsState;
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
