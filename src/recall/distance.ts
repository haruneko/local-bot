import type { EpisodeRecallHit } from "../memory/episode.js";
import type { RecalledEpisode, RecallPresentation } from "./types.js";

/** importance の正規化（1-10 → 0-1）。未設定は中立値 0.5 */
const IMPORTANCE_DEFAULT = 5;
const IMPORTANCE_MAX = 10;

/** 抑制の強さ（0=無効 〜 1=完全抑制）*/
const INHIBITION_WEIGHT = 0.7;

/** いま話している相手が参加したエピソードの relevance ボーナス（重み付けのみ。omit 判定には影響しない）*/
export const SPEAKER_MATCH_BOOST = 1.3;

/** コサイン類似度（正規化済みベクトル前提でも動く汎用実装）*/
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 候補ベクトルと抑制バッファの最大コサイン類似度を返す。ベクトルなし時は 0 */
function maxInhibition(vector: number[] | undefined, buffer: readonly number[][]): number {
  if (!vector || buffer.length === 0) return 0;
  let max = 0;
  for (const bv of buffer) {
    const sim = cosineSimilarity(vector, bv);
    if (sim > max) max = sim;
  }
  return max;
}

export const SUMMARIZE_MAX_CHARS = 80;

/** vague は固有名詞・事実を落とすため固定フレーズのみ */
export const VAGUE_PRESENTED =
  "（おぼろげな感触だけが残っている）";

/** LanceDB 既定の L2 距離（小さいほど類似）。厳しめ omit。 */
export type RecallDistanceThresholds = {
  fullMax: number;
  summarizeMax: number;
  vagueMax: number;
};

export const DEFAULT_RECALL_DISTANCE_THRESHOLDS: RecallDistanceThresholds = {
  fullMax: 0.45,
  summarizeMax: 0.72,
  vagueMax: 0.85,
};

/** 横断（ImageBind）空間の既定閾値。サービスが L2 正規化して返す前提（L2∈[0,2]）だが、
 *  nomic と意味距離の分布が違うので別物にする。実機で詰める（docs/ARCH-NEXT.md §4 のツマミ）。 */
export const DEFAULT_XMODAL_RECALL_DISTANCE_THRESHOLDS: RecallDistanceThresholds = {
  fullMax: 0.8,
  summarizeMax: 1.1,
  vagueMax: 1.3,
};

/** 半減期 ~70日。長く使って違和感があれば調整 */
const RECENCY_DECAY_LAMBDA = 0.01;

/** ISO 8601 → 経過日数に応じた減衰係数 0〜1。timestamp 未指定時は減衰なし（1） */
export function recencyDecay(
  timestamp: string | undefined,
  now = new Date(),
): number {
  if (!timestamp) return 1;
  const ageMs = now.getTime() - Date.parse(timestamp);
  if (ageMs <= 0) return 1;
  const ageDays = ageMs / 86_400_000;
  return Math.exp(-RECENCY_DECAY_LAMBDA * ageDays);
}

function mechanicalSummarize(text: string): string {
  const t = text.trim();
  if (!t) return "（内容不明）";
  if (t.length <= SUMMARIZE_MAX_CHARS) return t;
  return `${t.slice(0, SUMMARIZE_MAX_CHARS)}…`;
}

export function presentationFromDistance(
  distance: number,
  thresholds: RecallDistanceThresholds,
): RecallPresentation | "omit" {
  if (distance > thresholds.vagueMax) return "omit";
  if (distance <= thresholds.fullMax) return "full";
  if (distance <= thresholds.summarizeMax) return "summarize";
  return "vague";
}

export function resolvePresentedMechanical(
  presentation: RecallPresentation | "omit",
  body: string,
): string | null {
  if (presentation === "omit") return null;
  if (presentation === "full") return body.trim();
  if (presentation === "summarize") return mechanicalSummarize(body);
  return VAGUE_PRESENTED;
}

export type ClassifiedRecallHit = {
  id: number;
  body: string;
  distance: number;
  presentation: RecallPresentation;
  relevance: number;
  /** エピソードの発生時刻（ISO 8601）。想起提示で「N分前/N日前」に変換する用 */
  occurredAt?: string;
};

export type RecallScoreOptions = {
  /** 抑制バッファ（直近ターンで想起済みのベクトル群）*/
  inhibitionBuffer?: readonly number[][];
  /** いま話している相手の話者 ID。participants に含むヒットを重み付けする */
  currentSpeaker?: string;
};

/** 距離・recency・importance・抑制 を合算して relevance を決める（LLM 提示文は別段階） */
export function classifyRecallHits(
  hits: readonly EpisodeRecallHit[],
  thresholds: RecallDistanceThresholds = DEFAULT_RECALL_DISTANCE_THRESHOLDS,
  options: RecallScoreOptions = {},
  xmodalThresholds?: RecallDistanceThresholds,
): ClassifiedRecallHit[] {
  const result: ClassifiedRecallHit[] = [];
  const buffer = options.inhibitionBuffer ?? [];

  for (let id = 0; id < hits.length; id++) {
    const hit = hits[id]!;
    // 横断（ImageBind）ヒットは別空間＝別閾値（無ければ text 閾値にフォールバック）。
    const th =
      hit.space === "xmodal" && xmodalThresholds ? xmodalThresholds : thresholds;
    const presentation = presentationFromDistance(hit.distance, th);
    if (presentation === "omit") continue;

    const baseRelevance =
      distanceToRelevance(hit.distance, th.vagueMax) *
      recencyDecay(hit.timestamp);

    const importanceScore =
      ((hit.importance ?? IMPORTANCE_DEFAULT) / IMPORTANCE_MAX);

    const inhibition = maxInhibition(hit.vector, buffer);
    const inhibitionPenalty = Math.max(0, 1 - INHIBITION_WEIGHT * inhibition);

    const speakerBoost =
      options.currentSpeaker && hit.participants?.includes(options.currentSpeaker)
        ? SPEAKER_MATCH_BOOST
        : 1;

    result.push({
      id,
      body: hit.body,
      distance: hit.distance,
      presentation,
      relevance:
        baseRelevance * importanceScore * inhibitionPenalty * speakerBoost,
      occurredAt: hit.timestamp,
    });
  }

  return result.sort((a, b) => b.relevance - a.relevance);
}

/** L2 距離から relevance 0〜1（vagueMax を上限に正規化） */
export function distanceToRelevance(
  distance: number,
  vagueMax: number,
): number {
  if (distance > vagueMax) return 0;
  return Math.max(0, 1 - distance / vagueMax);
}

/** ベクトル検索ヒットを距離閾値でグラデーション提示する */
export function filterRecallByDistance(
  hits: readonly EpisodeRecallHit[],
  thresholds: RecallDistanceThresholds = DEFAULT_RECALL_DISTANCE_THRESHOLDS,
  options: RecallScoreOptions = {},
): RecalledEpisode[] {
  const classified = classifyRecallHits(hits, thresholds, options);
  const result: RecalledEpisode[] = [];

  for (const hit of classified) {
    const presented = resolvePresentedMechanical(hit.presentation, hit.body);
    if (!presented) continue;

    result.push({
      presented,
      relevance: hit.relevance,
      presentation: hit.presentation,
    });
  }

  return result.sort((a, b) => b.relevance - a.relevance);
}

/** テスト用: 本文だけから full として RecalledEpisode を作る */
export function fallbackRecalledEpisodes(
  episodes: string[],
): RecalledEpisode[] {
  return episodes.map((body) => ({
    presented: body,
    relevance: 1,
    presentation: "full" as const,
  }));
}
