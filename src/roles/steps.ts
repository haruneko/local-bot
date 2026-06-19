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
import { STEPS_SYSTEM } from "../prompts/roles.js";
import { stepsOpJsonSchema, stepsOpSchema } from "../prompts/schemas.js";
import type { LlmClient } from "../llm/types.js";
import { listSteps, loadSteps, saveSteps, type StepsState } from "../steps/state.js";
import { applyStepsOp, type StepsOp } from "../steps/ops.js";
import { renderSteps } from "../steps/render.js";
import { notesDir } from "../tools/notes.js";

/** steps facts.action（表示と focus 制御に使う） */
type StepsAction = "create" | "activate" | "shelve" | "retire" | "update";

/** バインダーの目次（steps 一覧）を LLM 向けに整形する。 */
function renderBacklog(
  steps: Awaited<ReturnType<typeof listSteps>>,
  focusId: string,
): string {
  const live = steps.filter((p) => !p.done && !p.retired);
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
function stepsContentEqual(a: StepsState, b: StepsState): boolean {
  const pick = (p: StepsState) =>
    JSON.stringify({
      title: p.title,
      goal: p.goal,
      milestones: p.milestones,
      current: p.current,
      log: p.log,
    });
  return pick(a) === pick(b);
}

function allMilestonesDone(p: StepsState): boolean {
  return p.milestones.length > 0 && p.milestones.every((m) => m.done);
}

/** 構造化steps から Obsidian 互換の markdown ミラーを書き出す（派生ビューなので決定的に上書き） */
async function writeStepsMirror(id: string, body: string): Promise<string> {
  const dir = path.join(notesDir(), "goals");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.md`), `${body}\n`, "utf8");
  return `goals/${id}.md`;
}

/**
 * steps actor 本体。LLM は op を1つ出すだけ。構造の更新・整形はコードが決定的に行う。
 * 文書生成も diff もさせない（強制ギプス）。
 */
export async function runSteps(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.action;
  const { currentDateTime } = input.ctx;
  const focusId = input.ctx.stepsId;
  const backlog = await listSteps();
  const focusSteps = focusId ? await loadSteps(focusId) : null;
  const focusRendered = focusSteps ? renderSteps(focusSteps) : "（いま集中している計画はない）";

  const speakerId =
    input.ctx.trigger.type === "user_message"
      ? input.ctx.trigger.speakerId
      : undefined;
  const speaker = speakerId
    ? input.ctx.dialogue.resolveUserDisplayName(speakerId)
    : "相手";
  const lastUserMessage = lastUserMessageFromContext(input.ctx);

  const format = stepsOpJsonSchema as Record<string, unknown>;
  const llmAttempts: string[] = [];
  let lastParseFailure: ParseJsonFailure | undefined;
  let op: StepsOp | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: STEPS_SYSTEM },
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
    const parsed = tryParseJsonWithSchema(raw, stepsOpSchema);
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
      "steps",
    );
  }

  if (op.op === "noop") return notAttempted();

  // view（参照・読み取り専用）: focus を変えず保存もしない。報告・確認・言及のための op。
  // stepsId 有り＝その計画の詳細／無し＝backlog 概観（「やり残しある？」への一覧）。言語野が body を読んで答える。
  if (op.op === "view") {
    const id = (op.stepsId ?? "").trim();
    if (id) {
      const p = await loadSteps(id);
      if (!p) {
        return actionFailed(action, "参照する計画が見つからない", {
          code: ACTION_ERROR_CODES.INVALID_ARGS,
          message: `view 対象の計画（${id}）が無い`,
        }, "steps");
      }
      return actionSucceeded(action, {
        kind: "steps",
        stepsId: id,
        filename: `goals/${id}.md`,
        body: renderSteps(p),
        achieved: false,
        action: "view",
      });
    }
    return actionSucceeded(action, {
      kind: "steps",
      stepsId: "",
      filename: "",
      body: `やり残し（いま進めてる段取り）:\n${renderBacklog(backlog, focusId)}`,
      achieved: false,
      action: "view",
    });
  }

  // 対象の計画を解決。new_goal は新規・それ以外は stepsId（省略時 focusSteps）。
  const targetId = (op.stepsId ?? "").trim() || focusId;
  const before = op.op === "new_goal" ? null : await loadSteps(targetId);

  if (op.op !== "new_goal" && !before) {
    return actionFailed(action, "対象の計画が見つからない", {
      code: ACTION_ERROR_CODES.INVALID_ARGS,
      message: `op=${op.op} の対象計画（${targetId || "未指定"}）が無い`,
    }, "steps");
  }

  let nextState = applyStepsOp(before, op, new Date());
  if (!nextState) {
    return actionFailed(action, "計画の操作を適用できなかった", {
      code: ACTION_ERROR_CODES.INVALID_ARGS,
      message: `op=${op.op} を適用できない`,
    }, "steps");
  }

  // 効果ゼロの編集（存在しない id への complete 等）は outcome にしない。
  // ただし activate/shelve は focus を動かす副作用が本体なので、内容不変でも通す。
  const focusOnlyOps = op.op === "activate" || op.op === "shelve";
  if (!focusOnlyOps && before && stepsContentEqual(before, nextState)) {
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

  await saveSteps(nextState);
  const body = renderSteps(nextState);
  const mirrorPath = await writeStepsMirror(nextState.id, body);

  const now = new Date().toISOString();
  await input.memoIndex?.upsert({
    path: mirrorPath,
    preview: body.slice(0, 200),
    createdAt: now,
    updatedAt: now,
  });

  // facts.action: 表示と focus 制御（orchestrator）に使う。
  const stepsAction: StepsAction =
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
    kind: "steps",
    stepsId: nextState.id,
    filename: mirrorPath,
    body,
    achieved,
    action: stepsAction,
  });
}
