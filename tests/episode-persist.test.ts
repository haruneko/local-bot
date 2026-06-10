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

  it("buildRecallQuery returns null for idle heartbeat with no content", () => {
    expect(buildRecallQuery({ type: "heartbeat" }, "", "", "")).toBeNull();
  });

  it("buildRecallQuery uses lastSpeech for heartbeat when no user utterance", () => {
    expect(
      buildRecallQuery({ type: "heartbeat" }, "", "次は塊魂を調べよう", ""),
    ).toBe("次は塊魂を調べよう");
  });

  it("buildRecallQuery uses innerState as mood fallback for heartbeat", () => {
    expect(
      buildRecallQuery({ type: "heartbeat" }, "", "", "穏やかな気持ち。"),
    ).toBe("穏やかな気持ち。");
  });

  it("T-IS04: buildRecallQuery uses concern before affect for heartbeat", () => {
    expect(
      buildRecallQuery(
        { type: "heartbeat" },
        "",
        "",
        "穏やかな気持ち。",
        "記憶アーキテクチャの実装方法",
      ),
    ).toBe("記憶アーキテクチャの実装方法");
  });

  it("T-IS04: buildRecallQuery falls back to affect when concern is empty", () => {
    expect(
      buildRecallQuery(
        { type: "heartbeat" },
        "",
        "",
        "穏やかな気持ち。",
        "",
      ),
    ).toBe("穏やかな気持ち。");
  });
});
