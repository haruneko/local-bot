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
    };
    await table.add([row]);
  }

  async recall(queryText: string, topK: number): Promise<EpisodeRecallHit[]> {
    const table = await this.ensureTable();
    const count = await table.countRows();
    if (count === 0) return [];

    const vector = await this.embedder.embed(queryText || ".");
    const results = await table
      .vectorSearch(vector)
      .limit(topK * 2)
      .toArray();
    return (results as (EpisodeRow & { _distance?: number })[])
      .filter((r) => r.body?.trim() && !r.deleted)
      .slice(0, topK)
      .map((r) => ({
        turnId: r.turnId,
        body: r.body,
        distance: r._distance ?? Number.POSITIVE_INFINITY,
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

  private async ensureTable(): Promise<lancedb.Table> {
    if (this.table) return this.table;
    const conn = await lancedb.connect(this.dbPath);
    this.table = await conn.openTable(TABLE_NAME);
    return this.table;
  }
}
