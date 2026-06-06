import type { SemanticRecallHit } from "../memory/semantic.js";
import { distanceToRelevance } from "./distance.js";

export type SemanticFactView = {
  body: string;
  relevance: number;
};

/** 意味記憶 recall で載せる距離上限（L2） */
export const DEFAULT_SEMANTIC_RECALL_MAX_DISTANCE = 0.75;

export function presentSemanticFacts(
  hits: readonly SemanticRecallHit[],
  maxDistance: number = DEFAULT_SEMANTIC_RECALL_MAX_DISTANCE,
): SemanticFactView[] {
  return hits
    .filter((hit) => hit.distance <= maxDistance && hit.body.trim())
    .map((hit) => ({
      body: hit.body.trim(),
      relevance: distanceToRelevance(hit.distance, maxDistance),
    }))
    .sort((a, b) => b.relevance - a.relevance);
}
