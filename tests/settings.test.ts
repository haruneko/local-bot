import { describe, expect, it } from "vitest";
import {
  resolveActivatorModel,
  resolveOllamaThink,
} from "../src/config/settings.js";

describe("resolveActivatorModel", () => {
  it("uses activatorModel when set", () => {
    expect(
      resolveActivatorModel({ activatorModel: "tiny", actionModel: "8b", chatModel: "35b" } as never),
    ).toBe("tiny");
  });

  it("falls back to actionModel, then chatModel", () => {
    expect(resolveActivatorModel({ actionModel: "8b", chatModel: "35b" } as never)).toBe("8b");
    expect(resolveActivatorModel({ chatModel: "35b" } as never)).toBe("35b");
  });
});

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
