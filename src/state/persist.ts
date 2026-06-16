import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentState, ConversationTurn } from "../types.js";

export const DEFAULT_AGENT_STATE: AgentState = "対話";

export type PersistedSession = {
  state: AgentState;
  workingMemory: ConversationTurn[];
  /** 感情余韻（旧 innerState）。空 = 起きたて */
  affect: string;
  /** 認知的焦点。空 = 特になし */
  concern: string;
  /** 集中モードで取り組み中の計画 id（data/plans/<id>.json）。空 = 取り組み中の計画なし */
  focusPlan: string;
  /** 集中が連続したターン数（集中力の上限＝強制ギプス用。ハートビート跨ぎで永続）。 */
  focusStreak: number;
  /** focusPlan に進捗が無いまま集中したターン数（進捗ベース卒業＝見限り用）。 */
  focusStall: number;
  /** focusPlan で観測した最高進捗（停滞判定の基準。planProgress 値）。 */
  focusBaseline: number;
  updatedAt: string;
};

export function defaultStatePath(cwd = process.cwd()): string {
  return path.join(cwd, "data", "state.json");
}

function isConversationTurn(value: unknown): value is ConversationTurn {
  if (!value || typeof value !== "object") return false;
  const t = value as ConversationTurn;
  if (t.role !== "user" && t.role !== "assistant") return false;
  if (typeof t.content !== "string") return false;
  if (t.speakerId !== undefined && typeof t.speakerId !== "string") return false;
  if (
    t.channel !== undefined &&
    t.channel !== "dialogue" &&
    t.channel !== "monologue"
  ) {
    return false;
  }
  if (t.createdAt !== undefined && typeof t.createdAt !== "string") return false;
  return true;
}

function parseWorkingMemory(raw: unknown): ConversationTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isConversationTurn);
}

export async function loadSession(
  filePath: string,
  fallbackState: AgentState = DEFAULT_AGENT_STATE,
): Promise<Pick<PersistedSession, "state" | "workingMemory" | "affect" | "concern" | "focusPlan" | "focusStreak" | "focusStall" | "focusBaseline">> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedSession & { innerState?: string }>;
    const state =
      typeof parsed.state === "string" && parsed.state.trim()
        ? parsed.state.trim()
        : fallbackState;
    const affect =
      typeof parsed.affect === "string"
        ? parsed.affect
        : typeof parsed.innerState === "string"
          ? parsed.innerState
          : "";
    const concern =
      typeof parsed.concern === "string" ? parsed.concern : "";
    const focusPlan =
      typeof parsed.focusPlan === "string" ? parsed.focusPlan : "";
    const focusStreak =
      typeof parsed.focusStreak === "number" && parsed.focusStreak >= 0
        ? parsed.focusStreak
        : 0;
    const focusStall =
      typeof parsed.focusStall === "number" && parsed.focusStall >= 0
        ? parsed.focusStall
        : 0;
    const focusBaseline =
      typeof parsed.focusBaseline === "number" && parsed.focusBaseline >= 0
        ? parsed.focusBaseline
        : 0;
    return {
      state,
      workingMemory: parseWorkingMemory(parsed.workingMemory),
      affect,
      concern,
      focusPlan,
      focusStreak,
      focusStall,
      focusBaseline,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn("[session] load failed, using defaults", err);
    }
  }
  return { state: fallbackState, workingMemory: [], affect: "", concern: "", focusPlan: "", focusStreak: 0, focusStall: 0, focusBaseline: 0 };
}

/** @deprecated loadSession を使う */
export async function loadAgentState(
  filePath: string,
  fallback: AgentState = DEFAULT_AGENT_STATE,
): Promise<AgentState> {
  return (await loadSession(filePath, fallback)).state;
}

export async function saveSession(
  filePath: string,
  session: {
    state: AgentState;
    workingMemory: readonly ConversationTurn[];
    affect?: string;
    concern?: string;
    focusPlan?: string;
    focusStreak?: number;
    focusStall?: number;
    focusBaseline?: number;
  },
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: PersistedSession = {
    state: session.state,
    workingMemory: [...session.workingMemory],
    affect: session.affect ?? "",
    concern: session.concern ?? "",
    focusPlan: session.focusPlan ?? "",
    focusStreak: session.focusStreak ?? 0,
    focusStall: session.focusStall ?? 0,
    focusBaseline: session.focusBaseline ?? 0,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** @deprecated saveSession を使う */
export async function saveAgentState(
  filePath: string,
  state: AgentState,
): Promise<void> {
  const existing = await loadSession(filePath, state);
  await saveSession(filePath, {
    state,
    workingMemory: existing.workingMemory,
    affect: existing.affect,
    concern: existing.concern,
  });
}
