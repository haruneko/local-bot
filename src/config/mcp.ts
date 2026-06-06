import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolCategory } from "../tools/catalog.js";

export type McpServerConfig = {
  name: string;
  enabled?: boolean;
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  categories: ToolCategory[];
};

export type McpConfig = {
  expressDryRun?: boolean;
  servers: McpServerConfig[];
};

export async function loadMcpConfig(): Promise<McpConfig> {
  const file = path.join(process.cwd(), "config", "mcp.json");
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as McpConfig;
  } catch {
    return { expressDryRun: true, servers: [] };
  }
}

export function resolveExpressDryRun(config: McpConfig): boolean {
  const env = process.env.EXPRESS_DRY_RUN?.trim().toLowerCase();
  if (env === "false" || env === "0" || env === "off") return false;
  if (env === "true" || env === "1" || env === "on") return true;
  return config.expressDryRun ?? true;
}
