import type { EpisodeRecallHit } from "../memory/episode.js";
import type { RecalledEpisode, RecallPresentation } from "./types.js";

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
  fullMax: 0.55,
  summarizeMax: 0.72,
  vagueMax: 0.85,
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
};

/** 距離だけで presentation を決める（LLM 提示文は別段階） */
export function classifyRecallHits(
  hits: readonly EpisodeRecallHit[],
  thresholds: RecallDistanceThresholds = DEFAULT_RECALL_DISTANCE_THRESHOLDS,
): ClassifiedRecallHit[] {
  const result: ClassifiedRecallHit[] = [];

  for (let id = 0; id < hits.length; id++) {
    const hit = hits[id]!;
    const presentation = presentationFromDistance(hit.distance, thresholds);
    if (presentation === "omit") continue;

    result.push({
      id,
      body: hit.body,
      distance: hit.distance,
      presentation,
      relevance:
        distanceToRelevance(hit.distance, thresholds.vagueMax) *
        recencyDecay(hit.timestamp),
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
): RecalledEpisode[] {
  const result: RecalledEpisode[] = [];

  for (const hit of hits) {
    const presentation = presentationFromDistance(hit.distance, thresholds);
    const presented = resolvePresentedMechanical(presentation, hit.body);
    if (!presented) continue;

    const validPresentation: RecallPresentation =
      presentation === "vague" || presentation === "summarize"
        ? presentation
        : "full";

    result.push({
      presented,
      relevance:
        distanceToRelevance(hit.distance, thresholds.vagueMax) *
        recencyDecay(hit.timestamp),
      presentation: validPresentation,
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
