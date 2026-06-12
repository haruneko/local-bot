import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { detectLlmRole } from "../src/util/verbose.js";

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
    expect(
      detectLlmRole([
        {
          role: "system",
          content: "キャラクタールールに従い、会話相手へのセリフだけを",
        },
        { role: "user", content: "x" },
      ]),
    ).toBe("language");
  });
});
