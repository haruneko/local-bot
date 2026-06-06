import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { detectLlmRole } from "../src/util/verbose.js";

describe("verbose CLI", () => {
  it("parseArgs enables verbose with --verbose", () => {
    expect(parseArgs(["--verbose"])).toEqual({ verbose: true });
  });

  it("parseArgs enables verbose with -v", () => {
    expect(parseArgs(["-v", "--user", "u2"])).toEqual({
      verbose: true,
      speakerId: "u2",
    });
  });
});

describe("detectLlmRole", () => {
  it("detects judge from system prompt", () => {
    expect(
      detectLlmRole([
        { role: "system", content: "あなたはジャッジくん" },
        { role: "user", content: "x" },
      ]),
    ).toBe("judge");
  });

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
