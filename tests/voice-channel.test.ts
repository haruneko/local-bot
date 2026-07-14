import { describe, expect, it, vi } from "vitest";
import { createVoiceOutputChannel } from "../src/voice/channel.js";

/** fake synthesize: テキストを受け取り即座に固定 Buffer を返す */
function makeFakeSynth(
  log: string[],
  failOn?: string,
): (text: string, cfg: { host: string; speaker: number }) => Promise<Buffer> {
  return async (text) => {
    log.push(`synth:${text}`);
    if (failOn && text === failOn) throw new Error(`fake synth error for "${text}"`);
    return Buffer.from(`wav:${text}`);
  };
}

/** fake play: Buffer を受け取りログを残す */
function makeFakePlay(
  log: string[],
  failOn?: string,
): (wav: Buffer) => Promise<void> {
  return async (wav) => {
    const label = wav.toString();
    log.push(`play:${label}`);
    if (failOn && label === failOn) throw new Error(`fake play error for "${label}"`);
  };
}

describe("createVoiceOutputChannel", () => {
  it("say: print が先、読み上げは直列（順序保証）", async () => {
    const order: string[] = [];

    const synth: (text: string, cfg: { host: string; speaker: number }) => Promise<Buffer> =
      async (text) => {
        order.push(`synth:${text}`);
        return Buffer.from(`wav:${text}`);
      };
    const play: (wav: Buffer) => Promise<void> = async (wav) => {
      order.push(`play:${wav.toString()}`);
    };

    const ch = createVoiceOutputChannel({
      print: (t) => order.push(`print:${t}`),
      printArtifact: (t) => order.push(`artifact:${t}`),
      voice: { host: "http://localhost:50021", speaker: 1 },
      _synthesize: synth,
      _play: play,
    });

    ch.say("こんにちは", []);
    ch.say("元気？", []);
    await ch.flush();

    // print は say() 呼び出し時点で即同期実行 → synth/play より前
    expect(order[0]).toBe("print:こんにちは");
    expect(order[1]).toBe("print:元気？");
    // synth と play は直列（こんにちは → 元気？ の順）
    const synthPlay = order.slice(2);
    expect(synthPlay).toEqual([
      "synth:こんにちは",
      "play:wav:こんにちは",
      "synth:元気？",
      "play:wav:元気？",
    ]);
  });

  it("synthesize 失敗時: skip して次を続行 + stderr 1行", async () => {
    const order: string[] = [];
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });

    const log: string[] = [];
    const ch = createVoiceOutputChannel({
      print: (t) => order.push(`print:${t}`),
      printArtifact: () => undefined,
      voice: { host: "http://localhost:50021", speaker: 1 },
      _synthesize: makeFakeSynth(log, "失敗テキスト"),
      _play: makeFakePlay(log),
    });

    ch.say("失敗テキスト", []);
    ch.say("成功テキスト", []);
    await ch.flush();

    // print は両方実行済み
    expect(order).toContain("print:失敗テキスト");
    expect(order).toContain("print:成功テキスト");

    // 失敗した文のあと、成功した文は再生された
    expect(log).toContain("synth:成功テキスト");
    expect(log).toContain("play:wav:成功テキスト");

    // stderr に1行出た
    expect(stderrLines.some((l) => l.includes("[voice] 読み上げ失敗"))).toBe(true);

    vi.restoreAllMocks();
    void origWrite; // suppress unused warning
  });

  it("play 失敗時: skip して次を続行 + stderr 1行", async () => {
    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });

    const log: string[] = [];
    const ch = createVoiceOutputChannel({
      print: () => undefined,
      printArtifact: () => undefined,
      voice: { host: "http://localhost:50021", speaker: 1 },
      _synthesize: makeFakeSynth(log),
      _play: makeFakePlay(log, "wav:失敗再生"),
    });

    ch.say("失敗再生", []);
    ch.say("成功再生", []);
    await ch.flush();

    // 失敗後も次が再生された
    expect(log).toContain("play:wav:成功再生");

    // stderr に1行出た
    expect(stderrLines.some((l) => l.includes("[voice] 読み上げ失敗"))).toBe(true);

    vi.restoreAllMocks();
  });

  it("artifacts は printArtifact のみ（読み上げない）", async () => {
    const log: string[] = [];
    const artifacts: string[] = [];

    const ch = createVoiceOutputChannel({
      print: (t) => log.push(`print:${t}`),
      printArtifact: (t) => artifacts.push(t),
      voice: { host: "http://localhost:50021", speaker: 1 },
      _synthesize: makeFakeSynth(log),
      _play: makeFakePlay(log),
    });

    ch.say("発話", ["成果物A", "成果物B"]);
    await ch.flush();

    // 成果物は printArtifact に届く
    expect(artifacts).toHaveLength(2);
    // 成果物は読み上げない（synth のログに成果物が無い）
    expect(log.filter((l) => l.startsWith("synth:"))).toEqual(["synth:発話"]);
  });

  it("speakSentence: キューに積まれ flush で待てる", async () => {
    const log: string[] = [];

    const ch = createVoiceOutputChannel({
      print: () => undefined,
      printArtifact: () => undefined,
      voice: { host: "http://localhost:50021", speaker: 1 },
      _synthesize: makeFakeSynth(log),
      _play: makeFakePlay(log),
    });

    ch.speakSentence("ストリーム文1");
    ch.speakSentence("ストリーム文2");
    await ch.flush();

    expect(log).toEqual([
      "synth:ストリーム文1",
      "play:wav:ストリーム文1",
      "synth:ストリーム文2",
      "play:wav:ストリーム文2",
    ]);
  });

  it("flush: キューが空になるまで待つ（非同期完了を保証）", async () => {
    let resolved = false;
    const log: string[] = [];

    const slowSynth: (text: string, cfg: { host: string; speaker: number }) => Promise<Buffer> =
      (text) =>
        new Promise((resolve) =>
          setTimeout(() => {
            log.push(`synth:${text}`);
            resolved = true;
            resolve(Buffer.from(`wav:${text}`));
          }, 10),
        );

    const ch = createVoiceOutputChannel({
      print: () => undefined,
      printArtifact: () => undefined,
      voice: { host: "http://localhost:50021", speaker: 1 },
      _synthesize: slowSynth,
      _play: makeFakePlay(log),
    });

    ch.say("遅延テスト", []);
    expect(resolved).toBe(false);
    await ch.flush();
    expect(resolved).toBe(true);
  });
});
