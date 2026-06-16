import { afterEach, describe, expect, it, vi } from "vitest";
import { reciprocalRankFusion } from "../src/recall/fuse.js";
import {
  ImageBindClient,
  NullXmodalEmbedder,
  createXmodalEmbedder,
} from "../src/embedding/xmodal.js";
import { InMemoryXmodalStore } from "../src/memory/xmodal-lancedb.js";
import {
  classifyRecallHits,
  DEFAULT_RECALL_DISTANCE_THRESHOLDS,
  DEFAULT_XMODAL_RECALL_DISTANCE_THRESHOLDS,
} from "../src/recall/distance.js";
import type { EpisodeRecallHit } from "../src/memory/episode.js";

describe("reciprocalRankFusion", () => {
  it("単一チャンネルは順位を保つ", () => {
    const out = reciprocalRankFusion([["a", "b", "c"]]);
    expect(out.map((f) => f.turnId)).toEqual(["a", "b", "c"]);
  });

  it("両チャンネルに出る turnId はスコアが加算され上位に来る", () => {
    // a は両方に、b/c は片方ずつ。a が最上位になるはず。
    const out = reciprocalRankFusion([
      ["b", "a"],
      ["c", "a"],
    ]);
    expect(out[0].turnId).toBe("a");
    expect(new Set(out.map((f) => f.turnId))).toEqual(new Set(["a", "b", "c"]));
  });

  it("turnId は重複せず dedup される", () => {
    const out = reciprocalRankFusion([
      ["a", "b"],
      ["a", "b"],
    ]);
    expect(out.map((f) => f.turnId)).toEqual(["a", "b"]);
  });

  it("空チャンネルは無視される", () => {
    const out = reciprocalRankFusion([[], ["a"], []]);
    expect(out.map((f) => f.turnId)).toEqual(["a"]);
  });
});

describe("createXmodalEmbedder（OFF が既定）", () => {
  it("未設定なら Null＝enabled false・embed は null", async () => {
    const e = createXmodalEmbedder(undefined);
    expect(e.enabled).toBe(false);
    expect(await e.embed({ kind: "text", text: "x" })).toBeNull();
  });

  it("enabled でも host が無ければ Null", () => {
    expect(createXmodalEmbedder({ enabled: true }).enabled).toBe(false);
  });

  it("enabled かつ host があれば ImageBindClient（enabled true）", () => {
    const e = createXmodalEmbedder({ enabled: true, host: "http://localhost:8800" });
    expect(e.enabled).toBe(true);
    expect(e).toBeInstanceOf(ImageBindClient);
  });

  it("NullXmodalEmbedder は常に null", async () => {
    expect(await new NullXmodalEmbedder().embed({ kind: "image", imageBase64: "" })).toBeNull();
  });
});

describe("ImageBindClient の degrade（サービス落ち＝null）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetch が throw したら null（接続不可）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const c = new ImageBindClient({ host: "http://localhost:9", timeoutMs: 50 });
    expect(await c.embed({ kind: "text", text: "x" })).toBeNull();
  });

  it("非 200 なら null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const c = new ImageBindClient({ host: "http://localhost:8800" });
    expect(await c.embed({ kind: "text", text: "x" })).toBeNull();
  });

  it("正常時はベクトルを返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ vector: [1, 2, 3] }) }),
    );
    const c = new ImageBindClient({ host: "http://localhost:8800" });
    expect(await c.embed({ kind: "text", text: "x" })).toEqual([1, 2, 3]);
  });

  it("空ベクトル/不正値は null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ vector: [] }) }),
    );
    const c = new ImageBindClient({ host: "http://localhost:8800" });
    expect(await c.embed({ kind: "text", text: "x" })).toBeNull();
  });
});

describe("classifyRecallHits — 横断ヒットは別閾値で出し分ける", () => {
  const hit = (over: Partial<EpisodeRecallHit>): EpisodeRecallHit => ({
    turnId: "t",
    body: "本文",
    distance: 1.0,
    ...over,
  });

  it("distance 1.0 の text ヒットは text 閾値(vagueMax 0.85)で omit される", () => {
    const out = classifyRecallHits(
      [hit({ space: "text" })],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      {},
      DEFAULT_XMODAL_RECALL_DISTANCE_THRESHOLDS,
    );
    expect(out).toHaveLength(0);
  });

  it("同じ distance 1.0 でも xmodal ヒットは横断閾値(vagueMax 1.3)で残る", () => {
    const out = classifyRecallHits(
      [hit({ space: "xmodal" })],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      {},
      DEFAULT_XMODAL_RECALL_DISTANCE_THRESHOLDS,
    );
    expect(out).toHaveLength(1);
  });

  it("xmodalThresholds 未指定なら xmodal ヒットも text 閾値にフォールバック", () => {
    const out = classifyRecallHits([hit({ space: "xmodal" })]);
    expect(out).toHaveLength(0);
  });
});

describe("InMemoryXmodalStore", () => {
  it("近い順（L2 小）に返す", async () => {
    const s = new InMemoryXmodalStore();
    await s.append("near", [0, 0, 0]);
    await s.append("far", [9, 9, 9]);
    const hits = await s.recall([0, 0, 0.1], 10);
    expect(hits.map((h) => h.turnId)).toEqual(["near", "far"]);
    expect(hits[0].distance).toBeLessThan(hits[1].distance);
  });

  it("remove で消える・同一 turnId の append は置き換え", async () => {
    const s = new InMemoryXmodalStore();
    await s.append("a", [1, 0]);
    await s.append("a", [0, 1]); // 置き換え
    await s.append("b", [5, 5]);
    await s.remove("b");
    const hits = await s.recall([0, 1], 10);
    expect(hits.map((h) => h.turnId)).toEqual(["a"]);
  });
});
