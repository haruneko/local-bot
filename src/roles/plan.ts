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
import { formatActionsForLanguage } from "../action/present.js";
import type { ActionOutcome } from "../types.js";
import { PLAN_SYSTEM } from "../prompts/roles.js";
import { planOpJsonSchema, planOpSchema } from "../prompts/schemas.js";
import type { LlmClient } from "../llm/types.js";
import { loadPlan, savePlan, type PlanState } from "../plan/state.js";
import { applyPlanOp, type PlanOp } from "../plan/ops.js";
import { renderPlan } from "../plan/render.js";
import { notesDir } from "../tools/notes.js";

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
  const activeId = input.ctx.planId;
  const current = activeId ? await loadPlan(activeId) : null;
  const rendered = current ? renderPlan(current) : "（まだ計画はない）";

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
            "このターンで実際に起きたこと（行動の結果）:",
            formatActionsForLanguage(input.ctx.actions),
            "",
            "いまの計画:",
            rendered,
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
    );
  }

  // 変更なし → 行動しなかった扱い（focusPlan / 集中入室を起こさない）
  if (op.op === "noop") return notAttempted();

  const before = op.op === "new_goal" ? null : current;
  let nextState = applyPlanOp(before, op, new Date());
  if (!nextState) {
    return actionFailed(action, "更新対象の計画がない", {
      code: ACTION_ERROR_CODES.INVALID_ARGS,
      message: "取り組み中の計画が無い状態で更新 op が来た",
    });
  }

  // 効果ゼロの op（存在しない id への complete 等）は outcome にしない
  if (before && planContentEqual(before, nextState)) return notAttempted();

  // 達成判定: 新たに全マイルストーン完了になったら達成ログを1回足す
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

  return actionSucceeded(action, {
    kind: "plan",
    planId: nextState.id,
    filename: mirrorPath,
    body,
    achieved,
  });
}
