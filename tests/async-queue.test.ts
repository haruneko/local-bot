import { describe, expect, it } from "vitest";
import { AsyncQueue } from "../src/util/async-queue.js";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("AsyncQueue", () => {
  it("push した順に反復し、end で終了する（先に全部積むケース）", async () => {
    const q = new AsyncQueue<string>();
    q.push("a");
    q.push("b");
    q.push("c");
    q.end();
    expect(await collect(q)).toEqual(["a", "b", "c"]);
  });

  it("消費が push より先行しても順序どおり届く（インターリーブ）", async () => {
    const q = new AsyncQueue<number>();
    const consumed = collect(q);
    // 消費側が先に待っている状態で非同期に push → end
    await Promise.resolve();
    q.push(1);
    q.push(2);
    await Promise.resolve();
    q.push(3);
    q.end();
    expect(await consumed).toEqual([1, 2, 3]);
  });

  it("end 後の push は無視される（反復結果に現れない）", async () => {
    const q = new AsyncQueue<string>();
    q.push("x");
    q.end();
    q.push("y"); // 無視される
    expect(await collect(q)).toEqual(["x"]);
  });

  it("end を待っている消費者を終端で起こす", async () => {
    const q = new AsyncQueue<string>();
    const consumed = collect(q);
    await Promise.resolve();
    q.end(); // 待っている next() を done で解決
    expect(await consumed).toEqual([]);
  });

  it("二重 end は安全（no-op）", async () => {
    const q = new AsyncQueue<string>();
    q.push("a");
    q.end();
    q.end();
    expect(await collect(q)).toEqual(["a"]);
  });
});
