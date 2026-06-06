import { describe, expect, it } from "vitest";
import { WorkingMemory } from "../src/memory/working.js";

describe("WorkingMemory", () => {
  it("T-W01: stores only conversation surface", () => {
    const wm = new WorkingMemory(10);
    wm.append({ role: "user", speakerId: "u1", content: "hi" });
    wm.append({ role: "assistant", content: "hello" });
    const recent = wm.getRecent();
    expect(recent).toHaveLength(2);
    expect(recent.every((t) => t.role === "user" || t.role === "assistant")).toBe(
      true,
    );
  });

  it("skips consecutive duplicate turns", () => {
    const wm = new WorkingMemory(10);
    wm.append({ role: "assistant", content: "same" });
    wm.append({ role: "assistant", content: "same" });
    wm.append({ role: "user", speakerId: "u1", content: "next" });
    expect(wm.getRecent()).toHaveLength(2);
  });

  it("dedupes on load from session", () => {
    const wm = new WorkingMemory(10, [
      { role: "assistant", content: "dup" },
      { role: "assistant", content: "dup" },
      { role: "user", speakerId: "u1", content: "ok" },
    ]);
    expect(wm.getRecent()).toHaveLength(2);
  });
});
