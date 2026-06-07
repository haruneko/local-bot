import { pseudoVector } from "./semantic.js";

export type MemoIndexEntry = {
  path: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoIndexHit = {
  path: string;
  preview: string;
  distance: number;
};

export interface MemoIndexStore {
  upsert(entry: MemoIndexEntry): Promise<void>;
  recall(queryText: string, topK: number): Promise<MemoIndexHit[]>;
  list(): Promise<MemoIndexEntry[]>;
}

function l2Distance(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

type InMemoryRecord = MemoIndexEntry & { vector: number[] };

export class InMemoryMemoIndexStore implements MemoIndexStore {
  private records: InMemoryRecord[] = [];

  async upsert(entry: MemoIndexEntry): Promise<void> {
    const vector = pseudoVector(entry.path + " " + entry.preview);
    const idx = this.records.findIndex((r) => r.path === entry.path);
    const record: InMemoryRecord = { ...entry, vector };
    if (idx >= 0) {
      this.records[idx] = record;
    } else {
      this.records.push(record);
    }
  }

  async recall(queryText: string, topK: number): Promise<MemoIndexHit[]> {
    const query = pseudoVector(queryText || ".");
    return this.records
      .map((r) => ({
        path: r.path,
        preview: r.preview,
        distance: l2Distance(query, r.vector),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, topK);
  }

  async list(): Promise<MemoIndexEntry[]> {
    return this.records.map(({ path, preview, createdAt, updatedAt }) => ({
      path,
      preview,
      createdAt,
      updatedAt,
    }));
  }
}
