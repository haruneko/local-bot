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
      },
    ]);
    await this.table.delete('id = "__seed__"');
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
    };
    await table.add([row]);
  }

  async recall(queryText: string, topK: number): Promise<EpisodeRecallHit[]> {
    const table = await this.ensureTable();
    const count = await table.countRows();
    if (count === 0) return [];

    const vector = await this.embedder.embed(queryText || ".");
    const results = await table.vectorSearch(vector).limit(topK).toArray();
    return (results as (EpisodeRow & { _distance?: number })[])
      .filter((r) => r.body?.trim())
      .map((r) => ({
        body: r.body,
        distance: r._distance ?? Number.POSITIVE_INFINITY,
      }));
  }

  private async ensureTable(): Promise<lancedb.Table> {
    if (this.table) return this.table;
    const conn = await lancedb.connect(this.dbPath);
    this.table = await conn.openTable(TABLE_NAME);
    return this.table;
  }
}
