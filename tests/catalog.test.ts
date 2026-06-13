import { describe, expect, it } from "vitest";
import { catalogForCategory } from "../src/tools/catalog.js";
import { FakeMcpToolProvider } from "../src/mcp/fake.js";
import { buildToolCatalog } from "../src/tools/catalog.js";

describe("tool catalog", () => {
  it("exposes research and express MCP tools by category", async () => {
    const catalog = await buildToolCatalog(new FakeMcpToolProvider());
    const research = catalogForCategory(catalog, "research");
    const express = catalogForCategory(catalog, "express");
    expect(research.some((t) => t.name === "web_search")).toBe(true);
    expect(express.some((t) => t.name === "post_tweet")).toBe(true);
  });
});
