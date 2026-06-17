import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  tryParseJsonWithSchema,
  type ParseJsonFailure,
} from "../action/parse-json.js";
import { ACTION_ERROR_CODES } from "../action/error.js";
import { errorFromLlmAttempts } from "../action/error.js";
import type { ActionErrorInfo } from "../action/error.js";
import { actionFailed, actionSucceeded } from "../action/outcome.js";
import { coerceToolArgs } from "../action/coerce-args.js";
import type { RunActionInput } from "../action/context.js";
import type { ActionOutcome } from "../types.js";
import type { CatalogTool, ToolCategory } from "../tools/catalog.js";
import { formatCatalogForPrompt } from "../tools/catalog.js";
import type { TurnContext } from "../context/turn-context.js";
import type { LlmClient } from "../llm/types.js";
import type { McpToolProvider } from "../mcp/types.js";
import { SUBAGENT_STEP_SYSTEM } from "../prompts/roles.js";

export const MAX_SUBAGENT_STEPS = 3;

export const subagentStepSchema = z.object({
  done: z.boolean(),
  tool: z.string().optional(),
  arguments: z.record(z.unknown()).optional(),
  reason: z.string().optional(),
});

export const subagentStepJsonSchema = zodToJsonSchema(subagentStepSchema, {
  name: "SubagentStep",
  $refStrategy: "none",
});

export type SubagentPickInput = {
  category: ToolCategory;
  intent: string;
  catalog: readonly CatalogTool[];
  ctx: TurnContext;
  priorSteps?: string[];
};

export type SubagentPickResult = {
  done: boolean;
  tool?: string;
  arguments?: Record<string, unknown>;
  reason?: string;
  /** ツール選択自体が LLM 失敗（パース不能等）だったときの構造化エラー。
   *  これがあるとき done=true は「完了」ではなく「失敗」を意味する */
  error?: ActionErrorInfo;
};

export async function runSubagentToolPick(
  llm: LlmClient,
  input: SubagentPickInput,
): Promise<SubagentPickResult> {
  const format = subagentStepJsonSchema as Record<string, unknown>;
  const attempts: string[] = [];
  let lastFailure: ParseJsonFailure | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const contextLines: string[] = [];
    const recentTurns = input.ctx.priorTurns.slice(-3);
    if (recentTurns.length > 0) {
      contextLines.push("直近の会話:");
      for (const t of recentTurns) {
        const speaker = t.role === "user" ? (t.speakerId ?? "相手") : "自分";
        contextLines.push(`${speaker}: ${t.content}`);
      }
    }
    if (input.ctx.partnerUtteranceLine) {
      contextLines.push(`現在のターン: ${input.ctx.partnerUtteranceLine}`);
    }

    const raw = await llm.chat(
      [
        { role: "system", content: SUBAGENT_STEP_SYSTEM },
        {
          role: "user",
          content: [
            `カテゴリ: ${input.category}`,
            `意図: ${input.intent}`,
            contextLines.length ? ["", ...contextLines].join("\n") : "",
            "",
            "利用可能なツール:",
            formatCatalogForPrompt(input.catalog),
            input.priorSteps?.length
              ? ["", "これまでのステップ:", ...input.priorSteps].join("\n")
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      { format, temperature: 0 },
    );
    attempts.push(raw);
    const parsed = tryParseJsonWithSchema(raw, subagentStepSchema);
    if (!parsed.ok) {
      lastFailure = parsed.failure;
      continue;
    }
    return parsed.value;
  }

  const error = errorFromLlmAttempts(
    attempts,
    lastFailure?.reason,
    lastFailure?.zodMessage,
  );
  return { done: true, reason: error.message, error };
}

async function executeMcpStep(
  mcp: McpToolProvider,
  tool: CatalogTool,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; summary: string; content: string }> {
  if (tool.source !== "mcp" || !tool.server) {
    return { ok: false, summary: "MCPツールではない", content: "" };
  }
  const coerced = coerceToolArgs(tool.parameters, args);
  if (!coerced.ok) {
    return { ok: false, summary: coerced.message, content: "" };
  }
  const result = await mcp.callTool(tool.server, tool.name, coerced.args);
  return {
    ok: result.ok,
    summary: result.summary,
    content: result.content ?? result.summary,
  };
}

function isNetworkError(summary: string): boolean {
  // -32603 は JSON-RPC の汎用 Internal error（引数不正でも出る）なので含めない。
  // ネットワーク障害だけを即失敗扱いにし、それ以外はクエリ変更でのリトライ余地を残す。
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|に接続できません/i.test(summary);
}

function findCatalogTool(
  catalog: readonly CatalogTool[],
  name: string,
): CatalogTool | undefined {
  return catalog.find((t) => t.name === name);
}

export async function runResearchSubagent(
  llm: LlmClient,
  input: RunActionInput,
  allowedToolNames?: string[],
): Promise<ActionOutcome> {
  const action = input.action;
  const catalog = input.toolCatalog ?? [];
  let tools = catalog.filter((t) => t.category === "research");
  // 起動 actor に応じてツールを絞る（webSearch→web_search のみ / urlBrowse→browse_url のみ）。
  // 両方渡すと「調べて」でも browse_url が選ばれ検索ページのゴミを掴むため。
  if (allowedToolNames && allowedToolNames.length > 0) {
    tools = tools.filter((t) => allowedToolNames.includes(t.name));
  }
  if (tools.length === 0) {
    return actionFailed(action, "探索ツールが設定されていない", {
      code: ACTION_ERROR_CODES.ACTION_DISCONNECTED,
      message: "research カテゴリの MCP ツールがない",
    }, "research");
  }

  const priorSteps: string[] = [];
  const executedCalls = new Set<string>();
  let lastContent = "";
  let lastTool = "";
  let lastSummary = "";
  let lastFailure: { summary: string; content: string } | undefined;

  for (let step = 0; step < MAX_SUBAGENT_STEPS; step++) {
    const pick = await runSubagentToolPick(llm, {
      category: "research",
      intent: action.intent,
      catalog: tools,
      ctx: input.ctx,
      priorSteps,
    });

    if (pick.done || !pick.tool) {
      if (lastContent) break;
      // ツール選択自体が LLM 失敗（パース不能等）→ 成功扱いにしない
      if (pick.error) {
        return actionFailed(action, "探索ツールを選べなかった", pick.error, "research");
      }
      if (lastFailure) {
        return actionFailed(action, "探索ツールの実行に失敗した", {
          code: ACTION_ERROR_CODES.TOOL_FAILED,
          message: lastFailure.summary,
          detail: lastFailure.content,
        }, "research");
      }
      return actionSucceeded(
        action,
        pick.reason ?? "探索を完了したが結果がない",
        "research",
      );
    }

    const callKey = `${pick.tool}:${JSON.stringify(pick.arguments ?? {})}`;
    if (executedCalls.has(callKey)) break;
    executedCalls.add(callKey);

    const tool = findCatalogTool(tools, pick.tool);
    if (!tool) {
      return actionFailed(action, "探索ツールが見つからない", {
        code: ACTION_ERROR_CODES.PICK_FAILED,
        message: `未知のツール: ${pick.tool}`,
      }, "research");
    }

    const result = await executeMcpStep(
      input.mcp!,
      tool,
      pick.arguments ?? {},
    );
    priorSteps.push(
      `${pick.tool}(${JSON.stringify(pick.arguments ?? {})}): ${result.ok ? "成功" : "失敗"} — ${result.summary}`,
    );

    if (!result.ok) {
      // ネットワーク障害（接続不可・タイムアウト等）はクエリ変更で解決しないので即失敗
      if (isNetworkError(result.summary)) {
        return actionFailed(action, "探索ツールに接続できない", {
          code: ACTION_ERROR_CODES.TOOL_FAILED,
          message: result.summary,
          detail: result.content,
        }, "research");
      }
      lastFailure = { summary: result.summary, content: result.content };
      continue;
    }

    lastContent = result.content;
    lastTool = pick.tool;
    lastSummary = result.summary;

    if (pick.done) break;
  }

  if (!lastContent) {
    return actionFailed(action, "探索ツールの実行に失敗した", {
      code: ACTION_ERROR_CODES.TOOL_FAILED,
      message: lastFailure?.summary ?? "探索結果が得られなかった",
      detail: lastFailure?.content,
    }, "research");
  }

  return actionSucceeded(action, {
    kind: "research",
    tool: lastTool || "research",
    title: action.intent,
    // ユーザーには要約だけ返す（全文 dump はチャットを流す）
    summary: researchSummaryForUser(lastContent, lastSummary),
    body: lastContent || lastSummary,
  });
}

/**
 * ユーザーに返す research 要約を本文から取り出す。
 * web_search の本文は「要約: <Tavily の答え>\n\n[出典...]」で始まる（mcp-research.mjs）ので
 * その要約部分だけ返す。それ以外（browse 等）は本文冒頭を短く。
 * MCP client の `summary` は "X を実行した" の汎用ラベル（中身なし）なので使わない。
 */
export function researchSummaryForUser(content: string, fallbackSummary: string): string {
  const c = (content ?? "").trim();
  if (c.startsWith("要約:")) {
    const idx = c.indexOf("\n\n");
    return (idx > 0 ? c.slice(0, idx) : c.slice(0, 600)).trim();
  }
  return c.slice(0, 500).trim() || fallbackSummary;
}

