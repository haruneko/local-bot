import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RecallDistanceThresholds } from "../recall/distance.js";
import { DEFAULT_RECALL_DISTANCE_THRESHOLDS } from "../recall/distance.js";

/** Ollama `think` API（推論モード）。false で thinking off */
export type OllamaThinkSetting = boolean | "high" | "medium" | "low";

export type AppSettings = {
  workingMemoryTurns: number;
  contextTokenBudget: number;
  episodeRecallTopK: number;
  /** LanceDB L2 距離による想起の濃さ（省略時は厳しめ既定値） */
  recallDistance?: Partial<RecallDistanceThresholds>;
  chatModel: string;
  embedModel: string;
  ollamaHost: string;
  /** 未指定時は false（thinking off） */
  ollamaThink?: OllamaThinkSetting;
  /** コンテキスト日時のタイムゾーン（IANA） */
  timeZone?: string;
};

export function resolveRecallDistanceThresholds(
  settings: AppSettings,
): RecallDistanceThresholds {
  return {
    ...DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    ...settings.recallDistance,
  };
}

export function resolveOllamaThink(
  settings: AppSettings,
): OllamaThinkSetting {
  const env = process.env.OLLAMA_THINK?.trim().toLowerCase();
  if (env === "false" || env === "0" || env === "off") return false;
  if (env === "true" || env === "1" || env === "on") return true;
  if (env === "high" || env === "medium" || env === "low") return env;
  return settings.ollamaThink ?? false;
}

export async function loadSettings(): Promise<AppSettings> {
  const file = path.join(process.cwd(), "config", "settings.json");
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as AppSettings;
}
