import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { XMODAL_DIM } from "../embedding/xmodal.js";

// 横断（ImageBind 1024）ベクトルの専用テーブル。エピソード本体（episodes）とは別テーブルにする
// ＝ nullable vector の地雷を避け、知覚エピソード（画像/音）にだけ行が付く。memo_index と同じ
// 「別テーブル（情報源/補助の記憶）」流儀。本体の想起は nomic 側で完全に生存するので、ここが
// 無くても（横断 OFF でも）壊れない。設計: docs/ARCH-NEXT.md「横断 embedding の設計」。

const TABLE_NAME = "episodes_xmodal";

export type XmodalHit = { turnId: string; distance: number };

export interface XmodalStore {
  /** turnId に横断ベクトルを付ける（知覚エピソードのみ）。 */
  append(turnId: string, vector: number[]): Promise<void>;
  /** 横断空間で近いものを返す（turnId と距離だけ。本文は episodes 側でハイドレート）。 */
  recall(vector: number[], topK: number): Promise<XmodalHit[]>;
  /** 忘却に追従（episodes 側 softDelete と一緒に消す）。該当が無くても黙って成功。 */
  remove(turnId: string): Promise<void>;
}

type XmodalRow = { id: string; vector: number[] };

export class LanceXmodalStore implements XmodalStore {
  private table: lancedb.Table | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly dim: number,
  ) {}

  static async open(dbPath: string, dim: number = XMODAL_DIM): Promise<LanceXmodalStore> {
    await mkdir(path.dirname(dbPath), { recursive: true });
    const store = new LanceXmodalStore(dbPath, dim);
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
    // 固定長 vector 列の schema を seed 行で確定してから消す（episodes と同じ手）。
    this.table = await conn.createTable(TABLE_NAME, [
      { id: "__seed__", vector: new Array(this.dim).fill(0) },
    ]);
    // id は小文字列なので単一引用符で確実に引ける（lancedb.ts の SQL クォート注意参照）。
    await this.table.delete("id = '__seed__'");
  }

  async append(turnId: string, vector: number[]): Promise<void> {
    if (!vector.length) return;
    const table = await this.ensureTable();
    // 同一 turnId の再付与は置き換え（重複行を作らない）。
    const escaped = turnId.replace(/'/g, "''");
    await table.delete(`id = '${escaped}'`);
    const row: XmodalRow = { id: turnId, vector };
    await table.add([row]);
  }

  async recall(vector: number[], topK: number): Promise<XmodalHit[]> {
    const table = await this.ensureTable();
    const count = await table.countRows();
    if (count === 0) return [];
    const results = (await table
      .vectorSearch(vector)
      .limit(Math.max(topK, 1))
      .toArray()) as (XmodalRow & { _distance?: number })[];
    return results
      .filter((r) => r.id && r.id !== "__seed__")
      .map((r) => ({ turnId: r.id, distance: r._distance ?? Number.POSITIVE_INFINITY }));
  }

  async remove(turnId: string): Promise<void> {
    const table = await this.ensureTable();
    const escaped = turnId.replace(/'/g, "''");
    await table.delete(`id = '${escaped}'`);
  }

  private async ensureTable(): Promise<lancedb.Table> {
    if (this.table) return this.table;
    const conn = await lancedb.connect(this.dbPath);
    this.table = await conn.openTable(TABLE_NAME);
    return this.table;
  }
}

/** テスト/メモリモード用。L2 で近い順に並べる素朴な実装。 */
export class InMemoryXmodalStore implements XmodalStore {
  private rows = new Map<string, number[]>();

  async append(turnId: string, vector: number[]): Promise<void> {
    if (vector.length) this.rows.set(turnId, vector);
  }

  async recall(vector: number[], topK: number): Promise<XmodalHit[]> {
    return [...this.rows.entries()]
      .map(([turnId, v]) => ({ turnId, distance: l2(vector, v) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, Math.max(topK, 0));
  }

  async remove(turnId: string): Promise<void> {
    this.rows.delete(turnId);
  }
}

function l2(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}
