import type { EpisodeMetadata } from "../types.js";

export type EpisodeRecord = {
  body: string;
  metadata: EpisodeMetadata;
  vector?: number[];
};

export type EpisodeRecallHit = {
  turnId: string;
  body: string;
  /** ベクトル距離（L2。小さいほど類似） */
  distance: number;
  /** ISO 8601。時間減衰スコアの計算に使う */
  timestamp?: string;
};

export interface EpisodeStore {
  append(record: EpisodeRecord): Promise<void>;
  recall(
    queryText: string,
    topK: number,
    excludeTurnIds?: ReadonlySet<string>,
    filterState?: string,
    since?: string,
    until?: string,
  ): Promise<EpisodeRecallHit[]>;
  /** timestamp 昇順で列挙（sinceIso 以降のみ。省略時は全件） */
  listSince(sinceIso?: string, limit?: number): Promise<EpisodeRecord[]>;
  /** ソフト削除。該当 turnId があれば true */
  softDelete(turnId: string): Promise<boolean>;
}

/** InMemory 用: 新しい記憶ほど距離が小さい想定 */
const IN_MEMORY_FAKE_DISTANCES = [0.35, 0.68, 1.05];

export class InMemoryEpisodeStore implements EpisodeStore {
  private records: EpisodeRecord[] = [];
  private deletedTurnIds = new Set<string>();

  async append(record: EpisodeRecord): Promise<void> {
    this.records.push(record);
  }

  async recall(
    _queryText: string,
    topK: number,
    excludeTurnIds?: ReadonlySet<string>,
    filterState?: string,
    since?: string,
    until?: string,
  ): Promise<EpisodeRecallHit[]> {
    const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
    const untilMs = until ? Date.parse(until) : Number.POSITIVE_INFINITY;
    const eligible = this.records
      .filter((r) => !this.deletedTurnIds.has(r.metadata.turnId))
      .filter(
        (r) => !excludeTurnIds?.size || !excludeTurnIds.has(r.metadata.turnId),
      )
      .filter((r) => !filterState || r.metadata.state === filterState)
      .filter((r) => {
        const ts = Date.parse(r.metadata.timestamp);
        return ts > sinceMs && ts < untilMs;
      });
    return eligible
      .slice(-topK)
      .reverse()
      .map((r, i) => ({
        turnId: r.metadata.turnId,
        body: r.body,
        distance: IN_MEMORY_FAKE_DISTANCES[i] ?? 1.5,
        timestamp: r.metadata.timestamp,
      }));
  }

  async listSince(sinceIso?: string, limit?: number): Promise<EpisodeRecord[]> {
    const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NEGATIVE_INFINITY;
    const filtered = this.records.filter((r) => {
      if (this.deletedTurnIds.has(r.metadata.turnId)) return false;
      if (!r.body.trim()) return false;
      return Date.parse(r.metadata.timestamp) > sinceMs;
    });
    const capped = limit ? filtered.slice(0, limit) : filtered;
    return capped.map((r) => ({ ...r }));
  }

  async softDelete(turnId: string): Promise<boolean> {
    const exists = this.records.some((r) => r.metadata.turnId === turnId);
    if (!exists) return false;
    this.deletedTurnIds.add(turnId);
    return true;
  }

  getAll(): readonly EpisodeRecord[] {
    return this.records;
  }
}
