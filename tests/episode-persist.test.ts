import { describe, expect, it } from "vitest";
import {
  buildRecallQuery,
  shouldPersistIntrospection,
} from "../src/orchestrator/episode-persist.js";
import {
  createTurnContext,
  withAction,
  withSpeech,
} from "../src/context/turn-context.js";

const dialogue = {
  resolveUserDisplayName: (id: string) => id,
};

function baseCtx(
  trigger: Parameters<typeof createTurnContext>[0]["trigger"],
) {
  return createTurnContext({
    turnId: "t-ep",
    state: "対話",
    trigger,
    dialogue,
    recentTurns: [],
    recalledEpisodes: [],
  });
}

describe("episode persist gate", () => {
  it("always persists user_message turns", () => {
    const ctx = baseCtx({ type: "user_message", content: "hi", speakerId: "u1" });
    expect(shouldPersistIntrospection(ctx)).toBe(true);
  });

  it("skips idle heartbeat", () => {
    const ctx = baseCtx({ type: "heartbeat" });
    expect(shouldPersistIntrospection(ctx)).toBe(false);
  });

  it("persists heartbeat with successful action", () => {
    const ctx = withAction(baseCtx({ type: "heartbeat" }), {
      attempted: true,
      kind: "memory",
      intent: "整理",
      status: "succeeded",
      facts: { kind: "memo_write", filename: "a.md", body: "ok" },
      summary: "ok",
    });
    expect(shouldPersistIntrospection(ctx)).toBe(true);
  });

  it("persists heartbeat with speech", () => {
    const ctx = withSpeech(baseCtx({ type: "heartbeat" }), "おはよう");
    expect(shouldPersistIntrospection(ctx)).toBe(true);
  });

  it("buildRecallQuery uses heartbeat state when no user utterance", () => {
    expect(
      buildRecallQuery({ type: "heartbeat" }, "静穏", ""),
    ).toBe("heartbeat 静穏");
  });
});
