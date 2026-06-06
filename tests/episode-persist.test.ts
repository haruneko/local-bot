import { describe, expect, it } from "vitest";
import {
  buildRecallQuery,
  shouldPersistIntrospection,
  shouldRunLanguage,
} from "../src/orchestrator/episode-persist.js";
import {
  createTurnContext,
  withAction,
  withJudge,
  withSpeech,
} from "../src/context/turn-context.js";
import { NONE_ACTION } from "../src/action/types.js";

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
    const ctx = withJudge(
      baseCtx({ type: "user_message", content: "hi", speakerId: "u1" }),
      { ACTION: NONE_ACTION, REPLY: false, NEXT_STATE: "静穏" },
    );
    expect(shouldPersistIntrospection(ctx)).toBe(true);
  });

  it("skips idle heartbeat", () => {
    const ctx = withJudge(baseCtx({ type: "heartbeat" }), {
      ACTION: NONE_ACTION,
      REPLY: false,
      NEXT_STATE: "静穏",
    });
    expect(shouldPersistIntrospection(ctx)).toBe(false);
  });

  it("persists heartbeat with successful action", () => {
    let ctx = withJudge(baseCtx({ type: "heartbeat" }), {
      ACTION: { kind: "memo_write", intent: "整理" },
      REPLY: false,
      NEXT_STATE: "静穏",
    });
    ctx = withAction(ctx, {
      attempted: true,
      kind: "memo_write",
      intent: "整理",
      status: "succeeded",
      facts: { kind: "memo_write", filename: "a.md", body: "ok" },
      summary: "ok",
    });
    expect(shouldPersistIntrospection(ctx)).toBe(true);
  });

  it("persists heartbeat with REPLY speech", () => {
    let ctx = withJudge(baseCtx({ type: "heartbeat" }), {
      ACTION: NONE_ACTION,
      REPLY: true,
      NEXT_STATE: "対話",
    });
    ctx = withSpeech(ctx, "おはよう");
    expect(shouldPersistIntrospection(ctx)).toBe(true);
  });

  it("buildRecallQuery uses heartbeat state when no user utterance", () => {
    expect(
      buildRecallQuery({ type: "heartbeat" }, "静穏", ""),
    ).toBe("heartbeat 静穏");
  });

  it("runs language on heartbeat when ACTION succeeded even if REPLY false", () => {
    let ctx = withJudge(baseCtx({ type: "heartbeat" }), {
      ACTION: NONE_ACTION,
      REPLY: false,
      NEXT_STATE: "対話",
    });
    ctx = withAction(ctx, {
      attempted: true,
      kind: "memo_read",
      intent: "読む",
      status: "succeeded",
      facts: { kind: "memo_read", filename: "a.md", body: "ok" },
      summary: "ok",
    });
    expect(shouldRunLanguage(ctx)).toBe(true);
  });

  it("skips language on heartbeat when ACTION none and REPLY false", () => {
    const ctx = withJudge(baseCtx({ type: "heartbeat" }), {
      ACTION: NONE_ACTION,
      REPLY: false,
      NEXT_STATE: "静穏",
    });
    expect(shouldRunLanguage(ctx)).toBe(false);
  });
});
