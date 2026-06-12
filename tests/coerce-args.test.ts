import { describe, expect, it } from "vitest";
import { coerceToolArgs } from "../src/action/coerce-args.js";

const urlSchema = {
  type: "object",
  properties: { url: { type: "string" } },
  required: ["url"],
};

describe("coerceToolArgs", () => {
  it("passes through valid string args", () => {
    const r = coerceToolArgs(urlSchema, { url: "https://example.com" });
    expect(r).toEqual({ ok: true, args: { url: "https://example.com" } });
  });

  it("unwraps an object with the same key (model double-wrap)", () => {
    const r = coerceToolArgs(urlSchema, { url: { url: "https://x.test" } });
    expect(r.ok && r.args.url).toBe("https://x.test");
  });

  it("unwraps an object with a single string value", () => {
    const r = coerceToolArgs(urlSchema, { url: { href: "https://y.test" } });
    expect(r.ok && r.args.url).toBe("https://y.test");
  });

  it("coerces number/boolean to string when schema wants string", () => {
    const schema = { properties: { q: { type: "string" } }, required: ["q"] };
    expect(coerceToolArgs(schema, { q: 42 })).toEqual({ ok: true, args: { q: "42" } });
  });

  it("fails clearly when a required string cannot be recovered", () => {
    const r = coerceToolArgs(urlSchema, { url: { a: 1, b: 2 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("url");
  });

  it("fails when a required arg is missing", () => {
    const r = coerceToolArgs(urlSchema, {});
    expect(r.ok).toBe(false);
  });

  it("fails when a required string is empty", () => {
    const r = coerceToolArgs(urlSchema, { url: "   " });
    expect(r.ok).toBe(false);
  });

  it("passes through unchanged when schema has no properties", () => {
    const r = coerceToolArgs({ type: "object", properties: {} }, { anything: { x: 1 } });
    expect(r).toEqual({ ok: true, args: { anything: { x: 1 } } });
  });

  it("leaves optional non-string objects untouched", () => {
    const schema = { properties: { date: { type: "string" } } };
    const r = coerceToolArgs(schema, { other: { nested: true } });
    expect(r).toEqual({ ok: true, args: { other: { nested: true } } });
  });
});
