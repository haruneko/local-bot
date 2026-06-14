import { describe, expect, it } from "vitest";
import {
  configureLlmConcurrency,
  runLimited,
  withLlmRetry,
  isRetriableLlmError,
} from "../src/llm/limit.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runLimited — 同時実行を上限に絞る", () => {
  it("上限を超えて並列実行しない（同時 in-flight が N を超えない）", async () => {
    configureLlmConcurrency(2);
    let inFlight = 0;
    let peak = 0;
    const task = () =>
      runLimited(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(20);
        inFlight--;
        return 1;
      });
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("withLlmRetry — 一過性のみ1回だけ再試行", () => {
  it("一過性エラーは再試行して成功する", async () => {
    let calls = 0;
    const out = await withLlmRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error("fetch failed");
        return "ok";
      },
      2,
      1,
    );
    expect(out).toBe("ok");
    expect(calls).toBe(2);
  });

  it("非一過性エラーは即座に投げる（再試行しない）", async () => {
    let calls = 0;
    await expect(
      withLlmRetry(
        async () => {
          calls++;
          throw new Error("JSON parse failed");
        },
        2,
        1,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("isRetriableLlmError: 速い一過性(429/ECONNREFUSED)は拾い、5分タイムアウトとparse失敗は拾わない", () => {
    expect(isRetriableLlmError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRetriableLlmError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isRetriableLlmError(new Error("fetch failed"))).toBe(true);
    // 5分かけて失敗するタイムアウトはリトライしない（倍待ちになるだけ）
    expect(isRetriableLlmError({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } })).toBe(false);
    expect(isRetriableLlmError(new Error("llm_parse_failed"))).toBe(false);
  });
});
