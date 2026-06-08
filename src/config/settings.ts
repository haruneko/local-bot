import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RecallDistanceThresholds } from "../recall/distance.js";
import { DEFAULT_RECALL_DISTANCE_THRESHOLDS } from "../recall/distance.js";

/** Ollama `think` API（推論モード）。false で thinking off */
export type OllamaThinkSetting = boolean | "high" | "medium" | "low";

/** State 別のコンテキスト設定（元データは変更しない・TurnContext に載せる量のみ絞る） */
export type StateConfigEntry = {
  workingMemoryTurns?: number;
  episodeRecallTopK?: number;
};

export type RoleName =
  | "memory"
  | "research"
  | "language"
  | "introspection"
  | "innerState";

/** ロール別モデル設定 */
export type RoleConfig = {
  model?: string;
  think?: OllamaThinkSetting;
};

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
  /** State 別コンテキスト設定。存在しない State はグローバル値を使用 */
  stateConfig?: Record<string, StateConfigEntry>;
  /** ロール別モデル設定。未指定ロールは chatModel / ollamaThink を使用 */
  roles?: Partial<Record<RoleName, RoleConfig>>;
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

/** State 別設定値を返す。該当 State がなければ空オブジェクト（グローバル値で補完される） */
export function resolveStateConfigEntry(
  settings: AppSettings,
  state: string,
): StateConfigEntry {
  return settings.stateConfig?.[state] ?? {};
}

/** ロールのモデル名を解決する。未設定は chatModel にフォールバック */
export function resolveRoleModel(
  settings: AppSettings,
  role: RoleName,
): string {
  return settings.roles?.[role]?.model ?? settings.chatModel;
}

/** ロールの think 設定を解決する。未設定はグローバル ollamaThink にフォールバック */
export function resolveRoleThink(
  settings: AppSettings,
  role: RoleName,
): OllamaThinkSetting {
  const roleThink = settings.roles?.[role]?.think;
  if (roleThink !== undefined) return roleThink;
  return resolveOllamaThink(settings);
}

export async function loadSettings(): Promise<AppSettings> {
  const file = path.join(process.cwd(), "config", "settings.json");
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as AppSettings;
}
