import { describe, expect, it } from "vitest";
import { resolveOllamaThink } from "../src/config/settings.js";

describe("resolveOllamaThink", () => {
  it("defaults to false when unset", () => {
    expect(resolveOllamaThink({} as never)).toBe(false);
  });

  it("uses settings value", () => {
    expect(resolveOllamaThink({ ollamaThink: "low" } as never)).toBe("low");
  });

  it("env OLLAMA_THINK overrides settings", () => {
    const prev = process.env.OLLAMA_THINK;
    process.env.OLLAMA_THINK = "false";
    try {
      expect(resolveOllamaThink({ ollamaThink: true } as never)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_THINK;
      else process.env.OLLAMA_THINK = prev;
    }
  });
});
