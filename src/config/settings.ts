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
  /** 意味記憶 recall の top-k（省略時 5） */
  semanticRecallTopK?: number;
  /** 意味記憶 recall の距離上限（省略時 0.75） */
  semanticRecallMaxDistance?: number;
  /** 夢バッチの最小エピソード件数（省略時 3） */
  dreamMinEpisodes?: number;
  /** エピソード想起から除外する直近ターン数（省略時 4） */
  recencyExclusionTurns?: number;
  /** LanceDB L2 距離による想起の濃さ（省略時は厳しめ既定値） */
  recallDistance?: Partial<RecallDistanceThresholds>;
  chatModel: string;
  embedModel: string;
  ollamaHost: string;
  /** 未指定時は false（thinking off） */
  ollamaThink?: OllamaThinkSetting;
  /** Ollama num_ctx: コンテキストウィンドウサイズ（未設定時は Ollama デフォルト 2048） */
  ollamaNumCtx?: number;
  /** 言語野の通常応答の num_predict 上限。-1 = 無制限（未設定時は 400） */
  languageNumPredict?: number;
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

export function resolveSemanticRecallTopK(settings: AppSettings): number {
  return settings.semanticRecallTopK ?? 5;
}

export function resolveSemanticRecallMaxDistance(settings: AppSettings): number {
  return settings.semanticRecallMaxDistance ?? 0.75;
}

export function resolveDreamMinEpisodes(settings: AppSettings): number {
  return settings.dreamMinEpisodes ?? 3;
}

export function resolveRecencyExclusionTurns(settings: AppSettings): number {
  return settings.recencyExclusionTurns ?? 4;
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
