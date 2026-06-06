import { randomUUID } from "node:crypto";

export type SemanticFact = {
  id: string;
  body: string;
  vector?: number[];
  tags: string[];
  confidence: number;
  sourceEpisodeIds: string[];
  firstSeen: string;
  lastReinforced: string;
  deleted: boolean;
};

export type SemanticRecallHit = {
  id: string;
  body: string;
  /** ベクトル距離（L2。小さいほど類似） */
  distance: number;
  confidence: number;
};

export type SemanticUpsertInput = {
  body: string;
  vector?: number[];
  tags?: string[];
  sourceEpisodeIds?: string[];
  /** 近接強化の距離閾値（省略時は既定値） */
  mergeDistanceMax?: number;
};

export type SemanticStore = {
  upsert(input: SemanticUpsertInput): Promise<SemanticFact>;
  recall(queryText: string, topK: number): Promise<SemanticRecallHit[]>;
  list(): Promise<SemanticFact[]>;
  softDelete(id: string): Promise<boolean>;
};

/** 近接 upsert で既存 fact と統合する距離上限 */
export const DEFAULT_SEMANTIC_MERGE_DISTANCE_MAX = 0.45;

function l2Distance(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** テスト用: 文字列から決定的な疑似ベクトルを生成 */
export function pseudoVector(text: string, dims = 8): number[] {
  const out = new Array<number>(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    out[i % dims] = (out[i % dims]! + text.charCodeAt(i)) % 97;
  }
  return out.map((v) => v / 97);
}

export class InMemorySemanticStore implements SemanticStore {
  private facts: SemanticFact[] = [];

  async upsert(input: SemanticUpsertInput): Promise<SemanticFact> {
    const now = new Date().toISOString();
    const vector = input.vector ?? pseudoVector(input.body);
    const mergeMax =
      input.mergeDistanceMax ?? DEFAULT_SEMANTIC_MERGE_DISTANCE_MAX;
    const tags = input.tags ?? [];
    const sourceEpisodeIds = input.sourceEpisodeIds ?? [];

    const active = this.facts.filter((f) => !f.deleted);
    let nearest: { fact: SemanticFact; distance: number } | null = null;
    for (const fact of active) {
      if (!fact.vector || fact.vector.length === 0) continue;
      const distance = l2Distance(vector, fact.vector);
      if (distance <= mergeMax && (!nearest || distance < nearest.distance)) {
        nearest = { fact, distance };
      }
    }

    if (nearest) {
      const mergedTags = [...new Set([...nearest.fact.tags, ...tags])];
      const mergedSources = [
        ...new Set([...nearest.fact.sourceEpisodeIds, ...sourceEpisodeIds]),
      ];
      const updated: SemanticFact = {
        ...nearest.fact,
        body: input.body.trim() || nearest.fact.body,
        vector,
        tags: mergedTags,
        confidence: nearest.fact.confidence + 1,
        sourceEpisodeIds: mergedSources,
        lastReinforced: now,
      };
      const idx = this.facts.findIndex((f) => f.id === nearest!.fact.id);
      this.facts[idx] = updated;
      return updated;
    }

    const created: SemanticFact = {
      id: randomUUID(),
      body: input.body.trim(),
      vector,
      tags,
      confidence: 1,
      sourceEpisodeIds,
      firstSeen: now,
      lastReinforced: now,
      deleted: false,
    };
    this.facts.push(created);
    return created;
  }

  async recall(queryText: string, topK: number): Promise<SemanticRecallHit[]> {
    const query = pseudoVector(queryText || ".");
    const active = this.facts.filter((f) => !f.deleted && f.body.trim());
    const scored = active
      .map((fact) => ({
        id: fact.id,
        body: fact.body,
        confidence: fact.confidence,
        distance: l2Distance(query, fact.vector ?? pseudoVector(fact.body)),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, topK);
    return scored;
  }

  async list(): Promise<SemanticFact[]> {
    return this.facts.filter((f) => !f.deleted);
  }

  async softDelete(id: string): Promise<boolean> {
    const idx = this.facts.findIndex((f) => f.id === id);
    if (idx < 0) return false;
    this.facts[idx] = { ...this.facts[idx]!, deleted: true };
    return true;
  }

  /** テスト用 */
  getAll(): readonly SemanticFact[] {
    return this.facts;
  }
}
