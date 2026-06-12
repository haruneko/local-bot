import { describe, expect, it } from "vitest";
import {
  createUserProfileResolver,
  createUserResolver,
  loadUsers,
  type UserEntry,
} from "../src/config/users.js";

describe("loadUsers", () => {
  it("parses display_name and optional note from config/users.yaml", async () => {
    const users = await loadUsers();
    const kuro = users.find((u) => u.id === "claude_kuro");
    expect(kuro?.display_name).toBe("クロ");
    expect(kuro?.note).toContain("相棒");
  });

  it("entries without a note still load (note is optional)", async () => {
    const users = await loadUsers();
    const kimi = users.find((u) => u.id === "U043VEVM2");
    expect(kimi?.display_name).toBe("kimikimi");
    expect(kimi?.note).toBeUndefined();
  });
});

describe("createUserProfileResolver", () => {
  const users: UserEntry[] = [
    { id: "u1", display_name: "HAL", note: "開発者。" },
    { id: "u2", display_name: "クロ" },
  ];

  it("returns displayName and note for a known speaker", () => {
    const resolve = createUserProfileResolver(users);
    expect(resolve("u1")).toEqual({ displayName: "HAL", note: "開発者。" });
  });

  it("omits note when not set", () => {
    const resolve = createUserProfileResolver(users);
    expect(resolve("u2")).toEqual({ displayName: "クロ" });
  });

  it("falls back to the id as displayName for unknown speakers", () => {
    const resolve = createUserProfileResolver(users);
    expect(resolve("ghost")).toEqual({ displayName: "ghost" });
  });

  it("createUserResolver still maps id → display name", () => {
    const resolve = createUserResolver(users);
    expect(resolve("u1")).toBe("HAL");
    expect(resolve("ghost")).toBe("ghost");
  });
});
