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
};

export interface EpisodeStore {
  append(record: EpisodeRecord): Promise<void>;
  recall(queryText: string, topK: number): Promise<EpisodeRecallHit[]>;
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

  async recall(_queryText: string, topK: number): Promise<EpisodeRecallHit[]> {
    return this.records
      .filter((r) => !this.deletedTurnIds.has(r.metadata.turnId))
      .slice(-topK)
      .reverse()
      .map((r, i) => ({
        turnId: r.metadata.turnId,
        body: r.body,
        distance: IN_MEMORY_FAKE_DISTANCES[i] ?? 1.5,
      }));
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
