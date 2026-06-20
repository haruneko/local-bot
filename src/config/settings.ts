import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RecallDistanceThresholds } from "../recall/distance.js";
import {
  DEFAULT_RECALL_DISTANCE_THRESHOLDS,
  DEFAULT_XMODAL_RECALL_DISTANCE_THRESHOLDS,
} from "../recall/distance.js";

/** Ollama `think` API（推論モード）。false で thinking off */
export type OllamaThinkSetting = boolean | "high" | "medium" | "low";

/** actor が参照できる TurnContext のチャンネル */
export type ContextChannel =
  | "conversation"
  | "inner_state"
  | "actor_list"
  | "image_feed"
  | "steps";

/** フラット actor pool のアクター名 */
export type ActorName =
  | "memo"
  | "webSearch"
  | "urlBrowse"
  | "webcam"
  | "steps"
  | "synthesize";

/** 各 actor の設定 */
export type ActorConfig = {
  enabled: boolean;
  /** 参照チャンネル。未設定は DEFAULT_ACTOR_CHANNELS[name] にフォールバック */
  channels?: ContextChannel[];
  /** 使用モデル。未設定は actionModel にフォールバック */
  model?: string;
};

/** actor ごとのデフォルト知覚チャンネル（activator と同一にすること） */
export const DEFAULT_ACTOR_CHANNELS: Record<ActorName, ContextChannel[]> = {
  memo:      ["conversation", "inner_state"],
  webSearch: ["conversation", "inner_state", "steps"],
  urlBrowse: ["conversation", "inner_state", "steps"],
  webcam:    ["conversation", "inner_state", "image_feed"],
  steps:      ["conversation", "inner_state", "steps"],
  synthesize: ["conversation", "inner_state", "steps"],
};

/** State 別のコンテキスト設定（元データは変更しない・TurnContext に載せる量のみ絞る） */
export type StateConfigEntry = {
  workingMemoryTurns?: number;
  episodeRecallTopK?: number;
  /** この State で有効な actor 名リスト。省略時はグローバル actors 設定を使用 */
  actors?: ActorName[];
};

/** per-turn state 解決済み設定。State が変わるたびに再計算される */
export type StateResolved = {
  enabledActors: ActorName[];
  episodeRecallTopK: number;
  workingMemoryTurns?: number;
  // 将来: stateごとに変わる設定をここに追加
};

export type RoleName =
  | "language"
  | "introspection"
  | "affect";

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
  /** 全実行 actors が使うモデル。未設定は chatModel にフォールバック */
  actionModel?: string;
  /** actor の起動判定（activate）が使うモデル。未設定は actionModel にフォールバック。
   *  起動判定は軽い判断なので小型・高速モデルを充て、actor 数が増えても安く保つ。 */
  activatorModel?: string;
  embedModel: string;
  /** 横断 embedding（音/絵/文字を 1 空間・ImageBind on Docker）。未設定/enabled=false で OFF＝
   *  今の nomic だけ挙動。docs/ARCH-NEXT.md「横断 embedding の設計」。 */
  crossmodal?: {
    /** 既定 false。true かつ host があるときだけ横断が立つ。 */
    enabled?: boolean;
    /** ImageBind HTTP サービス（例 http://localhost:8800）。 */
    host?: string;
    /** 1 リクエストのタイムアウト ms（既定 10000）。落ちてたら待たず null へ degrade。 */
    timeoutMs?: number;
    /** 横断ヒットのグラデーション距離閾値。未設定は横断既定（distance.ts）。実機で詰める。 */
    recallDistance?: Partial<RecallDistanceThresholds>;
  };
  ollamaHost: string;
  /** 未指定時は false（thinking off） */
  ollamaThink?: OllamaThinkSetting;
  /** Ollama num_ctx: コンテキストウィンドウサイズ（未設定時は Ollama デフォルト 2048） */
  ollamaNumCtx?: number;
  /** LLM 同時実行の上限（chat/embed 共通・未設定時は 4）。サーバの OLLAMA_NUM_PARALLEL と揃える */
  ollamaMaxConcurrency?: number;
  /** 言語野の通常応答の num_predict 上限。-1 = 無制限（未設定時は 400） */
  languageNumPredict?: number;
  /** コンテキスト日時のタイムゾーン（IANA） */
  timeZone?: string;
  /** 視覚センサーの出どころ（画像ファイルパス or ディレクトリ）。未設定 = 視覚オフ。
   *  カメラが無い間はファイルベース。後で webcam グラブや Wi-Fi カメラ URL に差し替え（docs/ARCH-NEXT.md） */
  imageFeedSource?: string;
  /** 取り込んだ画像の縮小上限（長辺・px）。未設定は 1024。高解像度はタイル増でトークン爆発するので
   *  取り込み口で縮小する（`src/sensor/image.ts`）。重ければ下げる（800 等）。 */
  imageMaxLongSide?: number;
  /** 明示的 recall actor での距離上限（未設定は 0.45＝背景想起の fullMax と同値）。
   *  背景より厳しくすると「背景には浮かんでるのに明示的に思い出せない」逆転が起きるため、
   *  背景の確信(full)層と揃える。それ以上の関連度は bullet 要約側で落とす */
  explicitRecallMaxDistance?: number;
  /** actor pool の設定（Layer 1: 全 State 共通の enabled/channels） */
  actors?: Partial<Record<ActorName, ActorConfig>>;
  /** State 別コンテキスト設定。存在しない State はグローバル値を使用 */
  stateConfig?: Record<string, StateConfigEntry>;
  /** ロール別モデル設定（language / introspection / affect）。未指定は chatModel / ollamaThink を使用 */
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

/** 横断（ImageBind）ヒットのグラデーション閾値。未設定は横断既定。 */
export function resolveXmodalRecallDistanceThresholds(
  settings: AppSettings,
): RecallDistanceThresholds {
  return {
    ...DEFAULT_XMODAL_RECALL_DISTANCE_THRESHOLDS,
    ...settings.crossmodal?.recallDistance,
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

/** activator + 全実行 actors のデフォルトモデル名を解決する */
export function resolveActionModel(settings: AppSettings): string {
  return settings.actionModel ?? settings.chatModel;
}

/** activator（actor の起動判定）が使うモデル。未設定は actionModel にフォールバック。
 *  起動判定は actor の RUN 用モデル（35B 等）と分離し、常に小型・高速に保つ。 */
export function resolveActivatorModel(settings: AppSettings): string {
  return settings.activatorModel ?? resolveActionModel(settings);
}

/** actor のモデル名を解決する。actor 個別設定 → actionModel → chatModel の順でフォールバック */
export function resolveActorModel(settings: AppSettings, name: ActorName): string {
  return settings.actors?.[name]?.model ?? resolveActionModel(settings);
}

/** 明示的 recall actor の距離上限を解決する（未設定は 0.45＝背景 fullMax と同値） */
export function resolveExplicitRecallMaxDistance(settings: AppSettings): number {
  return settings.explicitRecallMaxDistance ?? 0.45;
}

/** actor の知覚チャンネルを解決する。settings 未設定はデフォルトにフォールバック */
export function resolveActorChannels(
  settings: AppSettings,
  name: ActorName,
): ContextChannel[] {
  return settings.actors?.[name]?.channels ?? DEFAULT_ACTOR_CHANNELS[name];
}

/** State に応じた設定を毎ターン解決するクロージャを生成する */
export function createStateResolver(
  settings: AppSettings,
): (state: string) => StateResolved {
  return (state: string) => {
    const stateEntry = settings.stateConfig?.[state] ?? {};
    return {
      enabledActors: resolveEnabledActors(settings, state),
      episodeRecallTopK: stateEntry.episodeRecallTopK ?? settings.episodeRecallTopK,
      workingMemoryTurns: stateEntry.workingMemoryTurns,
    };
  };
}

/** State と設定から有効な ActorName[] を返す。
 *  Layer 2 (stateConfig.actors) → Layer 1 (actors.enabled) の順でフィルタ */
export function resolveEnabledActors(
  settings: AppSettings,
  state: string,
): ActorName[] {
  // registry に登録済みの actor だけ。webcam は型上の placeholder（未実装・registry 未登録）なので
  // フォールバックに入れない（入れても getActor で黙って drop されるだけ＝潜在 no-op を避ける）。
  const ALL_ACTORS: ActorName[] = [
    "memo",
    "webSearch", "urlBrowse", "steps", "synthesize",
  ];
  const stateActors = settings.stateConfig?.[state]?.actors;
  const candidates = stateActors ?? ALL_ACTORS;
  return candidates.filter((name) => {
    const cfg = settings.actors?.[name];
    return cfg === undefined || cfg.enabled !== false;
  });
}

export async function loadSettings(): Promise<AppSettings> {
  const file = path.join(process.cwd(), "config", "settings.json");
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as AppSettings;
}
