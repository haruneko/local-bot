import { describe, expect, it, vi } from "vitest";
import { FakeLlmClient } from "../src/llm/fake.js";
import { withVerboseLlm } from "../src/llm/logging.js";
import { configureLlmConcurrency, runLimitedStream } from "../src/llm/limit.js";
import type { LlmClient } from "../src/llm/types.js";
import type { VerboseLoggerImpl } from "../src/util/verbose.js";

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

describe("FakeLlmClient.chatStream", () => {
  it("連結が chat() の返り値と一致する", async () => {
    const text = "これはストリーミングのテスト用の十分に長い応答です";
    const fake = new FakeLlmClient([text, text]);
    const streamed = (await collect(fake.chatStream([{ role: "user", content: "hi" }]))).join("");
    const whole = await fake.chat([{ role: "user", content: "hi" }]);
    expect(streamed).toBe(text);
    expect(whole).toBe(text);
  });

  it("複数チャンクに分かれる（~8 文字ずつ）", async () => {
    const text = "0123456789abcdefghij"; // 20 文字 → 8+8+4 = 3 チャンク
    const fake = new FakeLlmClient([text]);
    const chunks = await collect(fake.chatStream([{ role: "user", content: "hi" }]));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(8);
  });

  it("calls を chat() と同形式で記録する", async () => {
    const fake = new FakeLlmClient(["abcdefghij"]);
    const messages = [{ role: "user" as const, content: "hi" }];
    const options = { temperature: 0.5 };
    await collect(fake.chatStream(messages, options));
    expect(fake.calls).toEqual([{ messages, options }]);
  });

  it("queue が尽きたら投げる", async () => {
    const fake = new FakeLlmClient([]);
    await expect(collect(fake.chatStream([{ role: "user", content: "hi" }]))).rejects.toThrow();
  });
});

describe("runLimitedStream — ストリームでも同時実行上限を守る", () => {
  it("反復中はスロットを占有し、終了で解放する", async () => {
    configureLlmConcurrency(2);
    let inFlight = 0;
    let peak = 0;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const task = async () => {
      const iter = runLimitedStream(async function* () {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(20);
        yield "a";
        await sleep(20);
        yield "b";
        inFlight--;
      });
      // 全部消費し切る
      for await (const _ of iter) {
        // 消費中もスロットを掴んでいる
      }
    };

    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("早期 break でもスロットを解放する（後続が進める）", async () => {
    configureLlmConcurrency(1);
    const order: string[] = [];

    const first = runLimitedStream(async function* () {
      order.push("first-start");
      yield "x";
      yield "y"; // ここには到達するが break で抜ける
    });
    const iter = first[Symbol.asyncIterator]();
    await iter.next(); // "x" を取り、スロット占有
    // 早期 break 相当: return() で generator を閉じる → finally でスロット解放
    await iter.return?.(undefined);

    // 上限 1 なので、解放されていなければ以下は永久に待つ
    await collect(
      runLimitedStream(async function* () {
        order.push("second-start");
        yield "z";
      }),
    );
    expect(order).toEqual(["first-start", "second-start"]);
  });

  it("反復本体が throw してもスロットを解放する", async () => {
    configureLlmConcurrency(1);
    await expect(
      collect(
        runLimitedStream(async function* () {
          yield "a";
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");
    // 解放されていれば次のストリームは通る
    const out = await collect(
      runLimitedStream(async function* () {
        yield "ok";
      }),
    );
    expect(out).toEqual(["ok"]);
  });
});

describe("withVerboseLlm — chatStream の透過とログ", () => {
  function fakeLogger() {
    const calls: { response: string }[] = [];
    const logger = {
      llm: vi.fn((_role, _messages, _options, response: string) => {
        calls.push({ response });
      }),
    } as unknown as VerboseLoggerImpl;
    return { logger, calls };
  }

  it("chatStream を透過し、差分を素通しして終了時に全文をログする", async () => {
    const text = "0123456789abcdefghij";
    const inner = new FakeLlmClient([text]);
    const { logger } = fakeLogger();
    const wrapped = withVerboseLlm(inner, logger);

    expect(wrapped.chatStream).toBeTypeOf("function");
    const chunks = await collect(wrapped.chatStream!([{ role: "user", content: "hi" }]));
    expect(chunks.length).toBeGreaterThan(1); // 差分素通し
    expect(chunks.join("")).toBe(text);
    // 終了時に連結全文でログ
    expect((logger.llm as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    const loggedResponse = (logger.llm as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(loggedResponse).toBe(text);
  });

  it("元クライアントに chatStream が無ければラップ後も生えない", () => {
    const noStream: LlmClient = {
      async chat() {
        return "x";
      },
    };
    const { logger } = fakeLogger();
    const wrapped = withVerboseLlm(noStream, logger);
    expect(wrapped.chatStream).toBeUndefined();
  });
});
