import type { EpisodeMetadata } from "../types.js";

export type EpisodeRecord = {
  body: string;
  metadata: EpisodeMetadata;
  vector?: number[];
};

export type EpisodeRecallHit = {
  body: string;
  /** ベクトル距離（L2。小さいほど類似） */
  distance: number;
};

export interface EpisodeStore {
  append(record: EpisodeRecord): Promise<void>;
  recall(queryText: string, topK: number): Promise<EpisodeRecallHit[]>;
}

/** InMemory 用: 新しい記憶ほど距離が小さい想定 */
const IN_MEMORY_FAKE_DISTANCES = [0.35, 0.68, 1.05];

export class InMemoryEpisodeStore implements EpisodeStore {
  private records: EpisodeRecord[] = [];

  async append(record: EpisodeRecord): Promise<void> {
    this.records.push(record);
  }

  async recall(_queryText: string, topK: number): Promise<EpisodeRecallHit[]> {
    return this.records
      .slice(-topK)
      .reverse()
      .map((r, i) => ({
        body: r.body,
        distance: IN_MEMORY_FAKE_DISTANCES[i] ?? 1.5,
      }));
  }

  getAll(): readonly EpisodeRecord[] {
    return this.records;
  }
}
