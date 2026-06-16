import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  describe("note is optional (fixture, not coupled to real config)", () => {
    let dir: string;
    let file: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "users-"));
      file = path.join(dir, "users.yaml");
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("entries without a note still load", async () => {
      await writeFile(
        file,
        [
          "users:",
          "  - id: with_note",
          "    display_name: のあり",
          "    note: 関係性の一文",
          "  - id: no_note",
          "    display_name: のなし",
          "",
        ].join("\n"),
        "utf8",
      );
      const users = await loadUsers(file);
      const noNote = users.find((u) => u.id === "no_note");
      expect(noNote?.display_name).toBe("のなし");
      expect(noNote?.note).toBeUndefined();
      const withNote = users.find((u) => u.id === "with_note");
      expect(withNote?.note).toBe("関係性の一文");
    });
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
