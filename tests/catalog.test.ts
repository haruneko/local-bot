import { describe, expect, it } from "vitest";
import {
  catalogForCategory,
  memoryCatalogTools,
  MEMORY_TOOL_KINDS,
} from "../src/tools/catalog.js";
import { FakeMcpToolProvider } from "../src/mcp/fake.js";
import { buildToolCatalog } from "../src/tools/catalog.js";

describe("tool catalog", () => {
  it("lists all memory tools including distill stub", () => {
    const tools = memoryCatalogTools();
    expect(tools.map((t) => t.name)).toEqual([...MEMORY_TOOL_KINDS]);
    expect(tools.every((t) => t.category === "memory")).toBe(true);
  });

  it("merges in-process and MCP tools", async () => {
    const catalog = await buildToolCatalog(new FakeMcpToolProvider());
    const research = catalogForCategory(catalog, "research");
    const express = catalogForCategory(catalog, "express");
    expect(research.some((t) => t.name === "web_search")).toBe(true);
    expect(express.some((t) => t.name === "post_tweet")).toBe(true);
  });
});
