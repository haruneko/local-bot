import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { OllamaEmbedClient } from "../llm/ollama.js";
import type { MemoIndexEntry, MemoIndexHit, MemoIndexStore } from "./memo-index.js";

const TABLE_NAME = "memo_index";

type MemoIndexRow = {
  id: string;
  path: string;
  filename: string;
  path_segments: string;
  depth_1: string;
  depth_2: string;
  depth_3: string;
  preview: string;
  vector: number[];
  created_at: string;
  updated_at: string;
  deleted: boolean;
};

function parsePathParts(entryPath: string): {
  filename: string;
  path_segments: string;
  depth_1: string;
  depth_2: string;
  depth_3: string;
} {
  const dir = path.dirname(entryPath);
  const segments = dir === "." ? [] : dir.split("/").filter(Boolean);
  return {
    filename: path.basename(entryPath),
    path_segments: JSON.stringify(segments),
    depth_1: segments[0] ?? "",
    depth_2: segments[1] ?? "",
    depth_3: segments[2] ?? "",
  };
}

export class LanceMemoIndexStore implements MemoIndexStore {
  private table: lancedb.Table | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly embedder: OllamaEmbedClient,
  ) {}

  static async open(
    dbPath: string,
    embedder: OllamaEmbedClient,
  ): Promise<LanceMemoIndexStore> {
    await mkdir(path.dirname(dbPath), { recursive: true });
    const store = new LanceMemoIndexStore(dbPath, embedder);
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
        path: "",
        filename: "",
        path_segments: "[]",
        depth_1: "",
        depth_2: "",
        depth_3: "",
        preview: "",
        vector,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        deleted: false,
      },
    ]);
    await this.table.delete('id = "__seed__"');
  }

  async upsert(entry: MemoIndexEntry): Promise<void> {
    const table = await this.ensureTable();
    const escaped = entry.path.replace(/'/g, "''");
    await table.delete(`id = '${escaped}'`);
    const vector = await this.embedder.embedDocument(entry.path + " " + entry.preview);
    const parts = parsePathParts(entry.path);
    const row: MemoIndexRow = {
      id: entry.path,
      path: entry.path,
      ...parts,
      preview: entry.preview,
      vector,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
      deleted: false,
    };
    await table.add([row]);
  }

  async recall(queryText: string, topK: number): Promise<MemoIndexHit[]> {
    const table = await this.ensureTable();
    const count = await table.countRows();
    if (count === 0) return [];
    const vector = await this.embedder.embedQuery(queryText || ".");
    const results = await table
      .vectorSearch(vector)
      .where("deleted = false")
      .limit(topK * 2)
      .toArray();
    return (results as (MemoIndexRow & { _distance?: number })[])
      .filter((r) => r.path?.trim() && !r.deleted)
      .slice(0, topK)
      .map((r) => ({
        path: r.path,
        preview: r.preview,
        distance: r._distance ?? Number.POSITIVE_INFINITY,
      }));
  }

  async delete(path: string): Promise<void> {
    const table = await this.ensureTable();
    const escaped = path.replace(/'/g, "''");
    await table.delete(`id = '${escaped}'`);
  }

  async list(): Promise<MemoIndexEntry[]> {
    const table = await this.ensureTable();
    const rows = (await table
      .query()
      .where("deleted = false")
      .toArray()) as MemoIndexRow[];
    return rows
      .filter((r) => r.path?.trim())
      .map((r) => ({
        path: r.path,
        preview: r.preview,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
  }

  private async ensureTable(): Promise<lancedb.Table> {
    if (this.table) return this.table;
    const conn = await lancedb.connect(this.dbPath);
    this.table = await conn.openTable(TABLE_NAME);
    return this.table;
  }
}
