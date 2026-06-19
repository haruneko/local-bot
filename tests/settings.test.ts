import { describe, expect, it } from "vitest";
import {
  loadSettings,
  resolveActivatorModel,
  resolveEnabledActors,
  resolveOllamaThink,
} from "../src/config/settings.js";

describe("集中 State の actor 解決", () => {
  it("実 config で全 State が steps actor を含む（静穏からの計画再開のため）", async () => {
    const s = await loadSettings();
    expect(resolveEnabledActors(s, "集中")).toContain("steps");
    expect(resolveEnabledActors(s, "対話")).toContain("steps");
    expect(resolveEnabledActors(s, "静穏")).toContain("steps");
  });
});

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
