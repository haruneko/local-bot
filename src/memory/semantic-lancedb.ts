import { randomUUID } from "node:crypto";
import * as lancedb from "@lancedb/lancedb";
import type { OllamaEmbedClient } from "../llm/ollama.js";
import {
  DEFAULT_SEMANTIC_MERGE_DISTANCE_MAX,
  type SemanticFact,
  type SemanticRecallHit,
  type SemanticStore,
  type SemanticUpsertInput,
} from "./semantic.js";

const TABLE_NAME = "semantic";

type SemanticRow = {
  id: string;
  body: string;
  vector: number[];
  tags: string;
  confidence: number;
  sourceEpisodeIds: string;
  firstSeen: string;
  lastReinforced: string;
  deleted: boolean;
};

function l2Distance(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function rowToFact(row: SemanticRow): SemanticFact {
  return {
    id: row.id,
    body: row.body,
    vector: row.vector,
    tags: JSON.parse(row.tags) as string[],
    confidence: row.confidence,
    sourceEpisodeIds: JSON.parse(row.sourceEpisodeIds) as string[],
    firstSeen: row.firstSeen,
    lastReinforced: row.lastReinforced,
    deleted: row.deleted,
  };
}

export class LanceSemanticStore implements SemanticStore {
  private table: lancedb.Table | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly embedder: OllamaEmbedClient,
  ) {}

  static async open(
    dbPath: string,
    embedder: OllamaEmbedClient,
  ): Promise<LanceSemanticStore> {
    const store = new LanceSemanticStore(dbPath, embedder);
    await store.init();
    return store;
  }

  private async init(): Promise<void> {
    const conn = await lancedb.connect(this.dbPath);
    const names = await conn.tableNames();
    if (names.includes(TABLE_NAME)) {
      this.table = await conn.openTable(TABLE_NAME);
      return;
    }
    const vector = await this.embedder.embed("init");
    this.table = await conn.createTable(TABLE_NAME, [
      {
        id: "__seed__",
        body: "",
        vector,
        tags: "[]",
        confidence: 0,
        sourceEpisodeIds: "[]",
        firstSeen: new Date(0).toISOString(),
        lastReinforced: new Date(0).toISOString(),
        deleted: true,
      },
    ]);
    await this.table.delete('id = "__seed__"');
  }

  async upsert(input: SemanticUpsertInput): Promise<SemanticFact> {
    const table = await this.ensureTable();
    const now = new Date().toISOString();
    const vector = input.vector ?? (await this.embedder.embedDocument(input.body));
    const mergeMax =
      input.mergeDistanceMax ?? DEFAULT_SEMANTIC_MERGE_DISTANCE_MAX;
    const tags = input.tags ?? [];
    const sourceEpisodeIds = input.sourceEpisodeIds ?? [];

    const rows = (await table
      .query()
      .where("deleted = false")
      .toArray()) as SemanticRow[];

    let nearest: { row: SemanticRow; distance: number } | null = null;
    for (const row of rows) {
      if (!row.body?.trim()) continue;
      const distance = l2Distance(vector, row.vector);
      if (distance <= mergeMax && (!nearest || distance < nearest.distance)) {
        nearest = { row, distance };
      }
    }

    if (nearest) {
      const existing = rowToFact(nearest.row);
      const mergedTags = [...new Set([...existing.tags, ...tags])];
      const mergedSources = [
        ...new Set([...existing.sourceEpisodeIds, ...sourceEpisodeIds]),
      ];
      const updated: SemanticFact = {
        ...existing,
        body: input.body.trim() || existing.body,
        vector,
        tags: mergedTags,
        confidence: existing.confidence + 1,
        sourceEpisodeIds: mergedSources,
        lastReinforced: now,
      };
      const escaped = existing.id.replace(/'/g, "''");
      await table.delete(`id = '${escaped}'`);
      await table.add([
        {
          id: updated.id,
          body: updated.body,
          vector: updated.vector!,
          tags: JSON.stringify(updated.tags),
          confidence: updated.confidence,
          sourceEpisodeIds: JSON.stringify(updated.sourceEpisodeIds),
          firstSeen: updated.firstSeen,
          lastReinforced: updated.lastReinforced,
          deleted: false,
        },
      ]);
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
    const row: SemanticRow = {
      id: created.id,
      body: created.body,
      vector: created.vector!,
      tags: JSON.stringify(created.tags),
      confidence: created.confidence,
      sourceEpisodeIds: JSON.stringify(created.sourceEpisodeIds),
      firstSeen: created.firstSeen,
      lastReinforced: created.lastReinforced,
      deleted: false,
    };
    await table.add([row]);
    return created;
  }

  async recall(queryText: string, topK: number): Promise<SemanticRecallHit[]> {
    const table = await this.ensureTable();
    const count = await table.countRows("deleted = false");
    if (count === 0) return [];

    const vector = await this.embedder.embedQuery(queryText || ".");
    const results = await table
      .vectorSearch(vector)
      .where("deleted = false")
      .limit(topK * 2)
      .toArray();
    return (results as (SemanticRow & { _distance?: number })[])
      .filter((r) => r.body?.trim())
      .slice(0, topK)
      .map((r) => ({
        id: r.id,
        body: r.body,
        confidence: r.confidence,
        distance: r._distance ?? Number.POSITIVE_INFINITY,
      }));
  }

  async list(): Promise<SemanticFact[]> {
    const table = await this.ensureTable();
    const rows = (await table
      .query()
      .where("deleted = false")
      .toArray()) as SemanticRow[];
    return rows.filter((r) => r.body?.trim()).map(rowToFact);
  }

  async softDelete(id: string): Promise<boolean> {
    const table = await this.ensureTable();
    const escaped = id.replace(/'/g, "''");
    const rows = await table
      .query()
      .where(`id = '${escaped}'`)
      .limit(1)
      .toArray();
    if (rows.length === 0) return false;
    await table.update({
      where: `id = '${escaped}'`,
      valuesSql: { deleted: "true" },
    });
    return true;
  }

  private async ensureTable(): Promise<lancedb.Table> {
    if (this.table) return this.table;
    const conn = await lancedb.connect(this.dbPath);
    this.table = await conn.openTable(TABLE_NAME);
    return this.table;
  }
}
