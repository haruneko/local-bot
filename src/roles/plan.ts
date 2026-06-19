import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ACTION_ERROR_CODES } from "../action/error.js";
import { errorFromLlmAttempts } from "../action/error.js";
import {
  tryParseJsonWithSchema,
  type ParseJsonFailure,
} from "../action/parse-json.js";
import { actionFailed, actionSucceeded, notAttempted } from "../action/outcome.js";
import { lastUserMessageFromContext, type RunActionInput } from "../action/context.js";
import type { ActionOutcome } from "../types.js";
import { PLAN_SYSTEM } from "../prompts/roles.js";
import { planOpJsonSchema, planOpSchema } from "../prompts/schemas.js";
import type { LlmClient } from "../llm/types.js";
import { listPlans, loadPlan, savePlan, type PlanState } from "../plan/state.js";
import { applyPlanOp, type PlanOp } from "../plan/ops.js";
import { renderPlan } from "../plan/render.js";
import { notesDir } from "../tools/notes.js";

/** plan facts.action（表示と focus 制御に使う） */
type PlanAction = "create" | "activate" | "shelve" | "retire" | "update";

/** バインダーの目次（plan 一覧）を LLM 向けに整形する。 */
function renderBacklog(
  plans: Awaited<ReturnType<typeof listPlans>>,
  focusId: string,
): string {
  const live = plans.filter((p) => !p.done && !p.retired);
  if (live.length === 0) return "（まだ計画はない）";
  return live
    .map((p) => {
      const here = p.id === focusId ? " ←いま集中中" : "";
      const where = p.current ? `・いま「${p.current}」` : "";
      return `- (${p.id}) ${p.title}（${p.completed}/${p.total}${where}）${here}`;
    })
    .join("\n");
}

/** 意味のある中身（updatedAt 等を除く）が同じか。効果ゼロ op の検出に使う */
function planContentEqual(a: PlanState, b: PlanState): boolean {
  const pick = (p: PlanState) =>
    JSON.stringify({
      title: p.title,
      goal: p.goal,
      milestones: p.milestones,
      current: p.current,
      log: p.log,
    });
  return pick(a) === pick(b);
}

function allMilestonesDone(p: PlanState): boolean {
  return p.milestones.length > 0 && p.milestones.every((m) => m.done);
}

/** 構造化plan から Obsidian 互換の markdown ミラーを書き出す（派生ビューなので決定的に上書き） */
async function writePlanMirror(id: string, body: string): Promise<string> {
  const dir = path.join(notesDir(), "goals");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.md`), `${body}\n`, "utf8");
  return `goals/${id}.md`;
}

/**
 * plan actor 本体。LLM は op を1つ出すだけ。構造の更新・整形はコードが決定的に行う。
 * 文書生成も diff もさせない（強制ギプス）。
 */
export async function runPlan(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.action;
  const { currentDateTime } = input.ctx;
  const focusId = input.ctx.planId;
  const backlog = await listPlans();
  const focusPlan = focusId ? await loadPlan(focusId) : null;
  const focusRendered = focusPlan ? renderPlan(focusPlan) : "（いま集中している計画はない）";

  const speakerId =
    input.ctx.trigger.type === "user_message"
      ? input.ctx.trigger.speakerId
      : undefined;
  const speaker = speakerId
    ? input.ctx.dialogue.resolveUserDisplayName(speakerId)
    : "相手";
  const lastUserMessage = lastUserMessageFromContext(input.ctx);

  const format = planOpJsonSchema as Record<string, unknown>;
  const llmAttempts: string[] = [];
  let lastParseFailure: ParseJsonFailure | undefined;
  let op: PlanOp | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: PLAN_SYSTEM },
        {
          role: "user",
          content: [
            `基準日時: ${currentDateTime}`,
            speakerId ? `あなたに話しかけている相手: ${speaker}（あなた自身ではない）` : "",
            `意図: ${action.intent}`,
            lastUserMessage ? `${speaker}があなたに言ったこと: ${lastUserMessage}` : "",
            "",
            "いまの計画一覧:",
            renderBacklog(backlog, focusId),
            "",
            "いま集中している計画:",
            focusRendered,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      { format, temperature: 0 },
    );
    llmAttempts.push(raw);
    const parsed = tryParseJsonWithSchema(raw, planOpSchema);
    if (parsed.ok) {
      op = parsed.value;
      break;
    }
    lastParseFailure = parsed.failure;
  }

  if (!op) {
    return actionFailed(
      action,
      "計画の操作を決められなかった",
      errorFromLlmAttempts(
        llmAttempts,
        lastParseFailure?.reason,
        lastParseFailure?.zodMessage,
      ),
      "plan",
    );
  }

  if (op.op === "noop") return notAttempted();

  // view（参照・読み取り専用）: focus を変えず保存もしない。報告・確認・言及のための op。
  // planId 有り＝その計画の詳細／無し＝backlog 概観（「やり残しある？」への一覧）。言語野が body を読んで答える。
  if (op.op === "view") {
    const id = (op.planId ?? "").trim();
    if (id) {
      const p = await loadPlan(id);
      if (!p) {
        return actionFailed(action, "参照する計画が見つからない", {
          code: ACTION_ERROR_CODES.INVALID_ARGS,
          message: `view 対象の計画（${id}）が無い`,
        }, "plan");
      }
      return actionSucceeded(action, {
        kind: "plan",
        planId: id,
        filename: `goals/${id}.md`,
        body: renderPlan(p),
        achieved: false,
        action: "view",
      });
    }
    return actionSucceeded(action, {
      kind: "plan",
      planId: "",
      filename: "",
      body: `やり残し（いま進めてる段取り）:\n${renderBacklog(backlog, focusId)}`,
      achieved: false,
      action: "view",
    });
  }

  // 対象の計画を解決。new_goal は新規・それ以外は planId（省略時 focusPlan）。
  const targetId = (op.planId ?? "").trim() || focusId;
  const before = op.op === "new_goal" ? null : await loadPlan(targetId);

  if (op.op !== "new_goal" && !before) {
    return actionFailed(action, "対象の計画が見つからない", {
      code: ACTION_ERROR_CODES.INVALID_ARGS,
      message: `op=${op.op} の対象計画（${targetId || "未指定"}）が無い`,
    }, "plan");
  }

  let nextState = applyPlanOp(before, op, new Date());
  if (!nextState) {
    return actionFailed(action, "計画の操作を適用できなかった", {
      code: ACTION_ERROR_CODES.INVALID_ARGS,
      message: `op=${op.op} を適用できない`,
    }, "plan");
  }

  // 効果ゼロの編集（存在しない id への complete 等）は outcome にしない。
  // ただし activate/shelve は focus を動かす副作用が本体なので、内容不変でも通す。
  const focusOnlyOps = op.op === "activate" || op.op === "shelve";
  if (!focusOnlyOps && before && planContentEqual(before, nextState)) {
    return notAttempted();
  }

  // 達成判定: 手動 complete で新たに全マイルストーン完了になったら達成ログを1回足す
  const achieved = allMilestonesDone(nextState);
  if (achieved && !(before && allMilestonesDone(before))) {
    nextState = {
      ...nextState,
      log: [
        ...nextState.log,
        { date: nextState.updatedAt.slice(0, 10), text: `ゴール「${nextState.title}」を達成` },
      ],
    };
  }

  await savePlan(nextState);
  const body = renderPlan(nextState);
  const mirrorPath = await writePlanMirror(nextState.id, body);

  const now = new Date().toISOString();
  await input.memoIndex?.upsert({
    path: mirrorPath,
    preview: body.slice(0, 200),
    createdAt: now,
    updatedAt: now,
  });

  // facts.action: 表示と focus 制御（orchestrator）に使う。
  const planAction: PlanAction =
    op.op === "new_goal"
      ? op.activate
        ? "activate"
        : "create"
      : op.op === "activate"
        ? "activate"
        : op.op === "shelve"
          ? "shelve"
          : op.op === "retire"
            ? "retire"
            : "update";

  return actionSucceeded(action, {
    kind: "plan",
    planId: nextState.id,
    filename: mirrorPath,
    body,
    achieved,
    action: planAction,
  });
}
