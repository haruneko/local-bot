import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentState, ConversationTurn } from "../types.js";

export const DEFAULT_AGENT_STATE: AgentState = "対話";

export type PersistedSession = {
  state: AgentState;
  workingMemory: ConversationTurn[];
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
  return true;
}

function parseWorkingMemory(raw: unknown): ConversationTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isConversationTurn);
}

export async function loadSession(
  filePath: string,
  fallbackState: AgentState = DEFAULT_AGENT_STATE,
): Promise<Pick<PersistedSession, "state" | "workingMemory">> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    const state =
      typeof parsed.state === "string" && parsed.state.trim()
        ? parsed.state.trim()
        : fallbackState;
    return {
      state,
      workingMemory: parseWorkingMemory(parsed.workingMemory),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn("[session] load failed, using defaults", err);
    }
  }
  return { state: fallbackState, workingMemory: [] };
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
  },
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: PersistedSession = {
    state: session.state,
    workingMemory: [...session.workingMemory],
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
  await saveSession(filePath, { state, workingMemory: existing.workingMemory });
}
