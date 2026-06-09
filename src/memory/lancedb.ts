import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { OllamaEmbedClient } from "../llm/ollama.js";
import type {
  EpisodeRecallHit,
  EpisodeRecord,
  EpisodeStore,
} from "./episode.js";

const TABLE_NAME = "episodes";

type EpisodeRow = {
  id: string;
  body: string;
  vector: number[];
  timestamp: string;
  participants: string;
  tags: string;
  state: string;
  /** LanceDB は null 不可のため空文字 = ACTION なし */
  action: string;
  source: string;
  reply: boolean;
  turnId: string;
  deleted: boolean;
  /** 重要度 1-10。addColumns マイグレーション前は undefined になりうる */
  importance?: number;
};

export class LanceEpisodeStore implements EpisodeStore {
  private table: lancedb.Table | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly embedder: OllamaEmbedClient,
  ) {}

  static async open(
    dbPath: string,
    embedder: OllamaEmbedClient,
  ): Promise<LanceEpisodeStore> {
    await mkdir(path.dirname(dbPath), { recursive: true });
    const store = new LanceEpisodeStore(dbPath, embedder);
    await store.init();
    return store;
  }

  private async init(): Promise<void> {
    const conn = await lancedb.connect(this.dbPath);
    const names = await conn.tableNames();
    if (names.includes(TABLE_NAME)) {
      this.table = await conn.openTable(TABLE_NAME);
      await this.ensureDeletedColumn();
      return;
    }
    const vector = await this.embedder.embed("init");
    this.table = await conn.createTable(TABLE_NAME, [
      {
        id: "__seed__",
        body: "",
        vector,
        timestamp: new Date(0).toISOString(),
        participants: "[]",
        tags: "[]",
        state: "静穏",
        action: "",
        source: "",
        reply: false,
        turnId: "__seed__",
        deleted: false,
      },
    ]);
    await this.table.delete('id = "__seed__"');
  }

  private async ensureDeletedColumn(): Promise<void> {
    const table = await this.ensureTable();
    const schema = await table.schema();
    const fields = schema.fields.map((f) => f.name);
    if (!fields.includes("deleted")) {
      await table.addColumns([{ name: "deleted", valueSql: "false" }]);
    }
    if (!fields.includes("importance")) {
      await table.addColumns([{ name: "importance", valueSql: "5.0" }]);
    }
  }

  async append(record: EpisodeRecord): Promise<void> {
    const table = await this.ensureTable();
    const vector =
      record.vector ?? (await this.embedder.embed(record.body));
    const row: EpisodeRow = {
      id: record.metadata.turnId,
      body: record.body,
      vector,
      timestamp: record.metadata.timestamp,
      participants: JSON.stringify(record.metadata.participants),
      tags: JSON.stringify(record.metadata.tags),
      state: record.metadata.state,
      action: record.metadata.action,
      source: record.metadata.source,
      reply: record.metadata.reply,
      turnId: record.metadata.turnId,
      deleted: false,
      importance: record.metadata.importance ?? 5,
    };
    await table.add([row]);
  }

  async listSince(sinceIso?: string, limit?: number): Promise<EpisodeRecord[]> {
    const table = await this.ensureTable();
    const rows = (await table
      .query()
      .where("deleted = false")
      .toArray()) as EpisodeRow[];
    const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NEGATIVE_INFINITY;
    const filtered = rows
      .filter((r) => r.body?.trim() && Date.parse(r.timestamp) > sinceMs)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const capped = limit ? filtered.slice(0, limit) : filtered;
    return capped.map((r) => ({
      body: r.body,
      metadata: {
        timestamp: r.timestamp,
        participants: JSON.parse(r.participants) as string[],
        tags: JSON.parse(r.tags) as string[],
        state: r.state,
        action: r.action,
        source: r.source as EpisodeRecord["metadata"]["source"],
        reply: r.reply,
        turnId: r.turnId,
      },
    }));
  }

  async recall(
    queryText: string,
    topK: number,
    excludeTurnIds?: ReadonlySet<string>,
    filterState?: string,
    since?: string,
    until?: string,
  ): Promise<EpisodeRecallHit[]> {
    const table = await this.ensureTable();
    const count = await table.countRows();
    if (count === 0) return [];

    const excludeSize = excludeTurnIds?.size ?? 0;
    const vector = await this.embedder.embed(queryText || ".");
    const escaped = filterState?.replace(/'/g, "''") ?? "";
    let where = filterState
      ? `deleted = false AND state = '${escaped}'`
      : "deleted = false";
    if (since) where += ` AND timestamp >= '${since}'`;
    if (until) where += ` AND timestamp < '${until}'`;
    const results = await table
      .vectorSearch(vector)
      .where(where)
      .limit(Math.max(topK + excludeSize, 1) * 2)
      .toArray();
    return (results as (EpisodeRow & { _distance?: number })[])
      .filter(
        (r) =>
          r.body?.trim() &&
          !r.deleted &&
          (!excludeTurnIds?.size || !excludeTurnIds.has(r.turnId)),
      )
      .slice(0, topK)
      .map((r) => ({
        turnId: r.turnId,
        body: r.body,
        distance: r._distance ?? Number.POSITIVE_INFINITY,
        timestamp: r.timestamp,
        vector: Array.isArray(r.vector) ? (r.vector as number[]) : undefined,
        importance: typeof r.importance === "number" ? r.importance : undefined,
      }));
  }

  async softDelete(turnId: string): Promise<boolean> {
    const table = await this.ensureTable();
    const escaped = turnId.replace(/'/g, "''");
    const rows = await table
      .query()
      .where(`turnId = '${escaped}'`)
      .limit(1)
      .toArray();
    if (rows.length === 0) return false;
    await table.update({
      where: `turnId = '${escaped}'`,
      valuesSql: { deleted: "true" },
    });
    return true;
  }

  async updateImportance(turnId: string, importance: number): Promise<void> {
    const table = await this.ensureTable();
    const escaped = turnId.replace(/'/g, "''");
    await table.update({
      where: `"turnId" = '${escaped}'`,
      valuesSql: { importance: String(importance) },
    });
  }

  private async ensureTable(): Promise<lancedb.Table> {
    if (this.table) return this.table;
    const conn = await lancedb.connect(this.dbPath);
    this.table = await conn.openTable(TABLE_NAME);
    return this.table;
  }
}
