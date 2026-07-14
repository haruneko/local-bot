import type { EpisodeRecallHit } from "../memory/episode.js";
import {
  classifyRecallHits,
  type RecallDistanceThresholds,
  type RecallScoreOptions,
} from "./distance.js";
import type { RecalledEpisode } from "./types.js";

/**
 * 距離分類（summarizeMax 超は omit）→ 残った本文を**そのまま**提示する（LLM なしの純関数）。
 * 旧 summarize 帯の LLM 要約は廃止（2026-07-14・DECISIONS §想起提示の LLM 要約廃止）。
 * decode 律速（実測 57 tok/s）で要約1回 ≈ 3秒 vs 本文 full の prefill 増 ≈ 0.3秒の逆ザヤ、
 * かつ LLM 要約は言語野が読む前に記憶を歪める劣化変換（メモ本文を要約しないのと同じ理屈）。
 * 遠さは relevance（距離×recency×importance）と occurredAt の時刻前置きが表す。
 */
export function presentRecallEpisodes(
  hits: readonly EpisodeRecallHit[],
  thresholds: RecallDistanceThresholds,
  scoreOptions: RecallScoreOptions = {},
  xmodalThresholds?: RecallDistanceThresholds,
): RecalledEpisode[] {
  const classified = classifyRecallHits(
    hits,
    thresholds,
    scoreOptions,
    xmodalThresholds,
  );
  const result: RecalledEpisode[] = [];
  for (const hit of classified) {
    const presented = hit.body.trim();
    if (!presented) continue;
    result.push({
      presented,
      relevance: hit.relevance,
      presentation: "full",
      occurredAt: hit.occurredAt,
    });
  }
  return result;
}
