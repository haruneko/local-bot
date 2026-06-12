import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { detectLlmRole } from "../src/util/verbose.js";
import {
  AFFECT_CONCERN_SYSTEM,
  INTROSPECTION_SYSTEM,
  MEMO_WRITE_SYSTEM,
  REMEMBER_SYSTEM,
} from "../src/prompts/roles.js";

const roleOf = (content: string) =>
  detectLlmRole([
    { role: "system", content },
    { role: "user", content: "x" },
  ]);

describe("verbose CLI", () => {
  it("parseArgs sets debug level with --verbose", () => {
    expect(parseArgs(["--verbose"])).toEqual({ logLevel: "debug" });
  });

  it("parseArgs sets debug level with -v", () => {
    expect(parseArgs(["-v", "--user", "u2"])).toEqual({
      logLevel: "debug",
      speakerId: "u2",
    });
  });

  it("parseArgs sets quiet level with --quiet / -q", () => {
    expect(parseArgs(["--quiet"])).toEqual({ logLevel: "quiet" });
    expect(parseArgs(["-q"])).toEqual({ logLevel: "quiet" });
  });

  it("parseArgs leaves logLevel undefined by default (entrypoint decides)", () => {
    expect(parseArgs([])).toEqual({});
  });
});

describe("detectLlmRole", () => {
  it("detects language from character rule prefix", () => {
    expect(roleOf("キャラクタールールに従い、会話相手へのセリフだけを")).toBe(
      "language",
    );
  });

  it("detects activate with the actor name", () => {
    expect(roleOf("あなたは memoWrite の起動判定係です。\n役割: …")).toBe(
      "activate.memoWrite",
    );
  });

  it("distinguishes the prompts that all contain 内省", () => {
    // 内心・内省・remember・memo_write はどれも誤分類しやすい
    expect(roleOf(AFFECT_CONCERN_SYSTEM)).toBe("inner_state");
    expect(roleOf(INTROSPECTION_SYSTEM)).toBe("introspection");
    expect(roleOf(REMEMBER_SYSTEM)).toBe("remember");
    expect(roleOf(MEMO_WRITE_SYSTEM)).toBe("memo_write");
  });
});
