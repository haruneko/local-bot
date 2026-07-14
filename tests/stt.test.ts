import { describe, expect, it, vi } from "vitest";
import { transcribe } from "../src/voice/stt.js";
import { startRecording } from "../src/voice/record.js";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

// -----------------------------------------------------------------------
// transcribe のテスト
// -----------------------------------------------------------------------

describe("transcribe — リクエスト整形と応答パース", () => {
  const DUMMY_HOST = "http://localhost:11434";
  const DUMMY_MODEL = "gemma4:e2b";
  const dummyWav = Buffer.from("RIFF....WAV", "utf-8");

  it("OpenAI 互換の shape でリクエストを送る", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "テスト文字起こし" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await transcribe(dummyWav, { host: DUMMY_HOST, model: DUMMY_MODEL }, mockFetch);

    expect(capturedUrl).toBe(`${DUMMY_HOST}/v1/chat/completions`);
    expect(mockFetch).toHaveBeenCalledOnce();

    const body = capturedBody as {
      model: string;
      messages: Array<{
        role: string;
        content: Array<{ type: string; input_audio?: { data: string; format: string } }>;
      }>;
    };
    expect(body.model).toBe(DUMMY_MODEL);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");

    // content 配列に text と input_audio が含まれる
    const contentArr = body.messages[0].content;
    const textPart = contentArr.find((c) => c.type === "text");
    const audioPart = contentArr.find((c) => c.type === "input_audio");
    expect(textPart).toBeDefined();
    expect(audioPart).toBeDefined();
    expect(audioPart?.input_audio?.format).toBe("wav");
    // base64 エンコード済みの wav データが入っている
    expect(audioPart?.input_audio?.data).toBe(dummyWav.toString("base64"));
  });

  it("model 名を反映する", async () => {
    let capturedModel = "";
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { model: string };
      capturedModel = body.model;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 },
      );
    });

    await transcribe(dummyWav, { host: DUMMY_HOST, model: "custom-model" }, mockFetch);
    expect(capturedModel).toBe("custom-model");
  });

  it("choices[0].message.content を trim して返す", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "  hello world  " } }] }),
        { status: 200 },
      ),
    );
    const result = await transcribe(dummyWav, { host: DUMMY_HOST, model: DUMMY_MODEL }, mockFetch);
    expect(result).toBe("hello world");
  });

  it("content が空文字のとき空文字を返す", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "   " } }] }),
        { status: 200 },
      ),
    );
    const result = await transcribe(dummyWav, { host: DUMMY_HOST, model: DUMMY_MODEL }, mockFetch);
    expect(result).toBe("");
  });

  it("choices が無い応答は空文字を返す", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const result = await transcribe(dummyWav, { host: DUMMY_HOST, model: DUMMY_MODEL }, mockFetch);
    expect(result).toBe("");
  });

  it("HTTP エラーは throw する", async () => {
    const mockFetch = vi.fn(async () =>
      new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
    );
    await expect(
      transcribe(dummyWav, { host: DUMMY_HOST, model: DUMMY_MODEL }, mockFetch),
    ).rejects.toThrow("500");
  });

  it("fetch 失敗（ネットワークエラー）は throw する", async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      transcribe(dummyWav, { host: DUMMY_HOST, model: DUMMY_MODEL }, mockFetch),
    ).rejects.toThrow("STT リクエスト失敗");
  });
});

// -----------------------------------------------------------------------
// startRecording のテスト
// -----------------------------------------------------------------------

describe("startRecording — spawn 引数と stop の流れ", () => {
  /** テスト用の偽 ChildProcess を作るヘルパー */
  function makeChildProcess(): ChildProcess & { _emit: (event: string) => void; killedWith: string | null } {
    const emitter = new EventEmitter() as ChildProcess;
    // ChildProcess に必要な最低限のプロパティを追加
    let killed: string | null = null;
    (emitter as unknown as { exitCode: number | null }).exitCode = null;
    (emitter as unknown as { kill: (sig: string) => void }).kill = (sig: string) => {
      killed = sig;
      // 非同期で close イベントを発行（stop() の await を解決するため）
      setTimeout(() => emitter.emit("close", 0), 0);
    };
    const obj = emitter as unknown as ChildProcess & { _emit: (event: string) => void; killedWith: string | null };
    Object.defineProperty(obj, "killedWith", { get: () => killed });
    obj._emit = (event: string) => emitter.emit(event);
    return obj;
  }

  it("parecord に --format=s16le --rate=16000 --channels=1 --file-format=wav を渡す", async () => {
    let spawnedCmd = "";
    let spawnedArgs: string[] = [];

    const child = makeChildProcess();
    const mockSpawn = vi.fn((cmd: string, args: string[]) => {
      spawnedCmd = cmd;
      spawnedArgs = args;
      return child;
    });
    const mockCheck = vi.fn(() => true);

    // wav が読み込めるようにするため readFile をモックする必要があるが、
    // ここでは spawn の引数確認だけを検証する。
    // stop() は実際に呼ぶと readFile が走るので、引数チェックのみ。
    startRecording("/tmp/test.wav", mockSpawn as never, mockCheck);

    expect(spawnedCmd).toBe("parecord");
    expect(spawnedArgs).toContain("--format=s16le");
    expect(spawnedArgs).toContain("--rate=16000");
    expect(spawnedArgs).toContain("--channels=1");
    expect(spawnedArgs).toContain("--file-format=wav");
    expect(spawnedArgs).toContain("/tmp/test.wav");
  });

  it("stop() で SIGINT を送る", async () => {
    const child = makeChildProcess();
    const mockSpawn = vi.fn(() => child);
    const mockCheck = vi.fn(() => true);

    // readFile/unlink をモック
    vi.mock("node:fs/promises", () => ({
      readFile: vi.fn(async () => Buffer.from("WAVDATA")),
      unlink: vi.fn(async () => undefined),
    }));

    const handle = startRecording("/tmp/test.wav", mockSpawn as never, mockCheck);
    // stop() を呼ぶと SIGINT が飛ぶ
    const stopPromise = handle.stop();
    // close イベントが setTimeout で飛ぶのを待つ
    await stopPromise.catch(() => {/* readFile モックが無い場合は失敗を無視 */});

    expect(child.killedWith).toBe("SIGINT");
  });

  it("parecord が無い場合は分かりやすいエラーを throw する", () => {
    const mockSpawn = vi.fn();
    const mockCheck = vi.fn(() => false); // parecord 無し

    expect(() =>
      startRecording("/tmp/test.wav", mockSpawn as never, mockCheck),
    ).toThrow("pulseaudio-utils");
  });
});
