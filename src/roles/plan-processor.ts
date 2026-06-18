import { tryParseJsonWithSchema } from "../action/parse-json.js";
import { PLAN_MILESTONE_JUDGE_SYSTEM } from "../prompts/roles.js";
import {
  planMilestoneJudgeJsonSchema,
  planMilestoneJudgeSchema,
} from "../prompts/schemas.js";
import type { LlmClient } from "../llm/types.js";
import type { Milestone, PlanState } from "../plan/state.js";

export type PlanProcessorResult = {
  /** 更新後の計画（completedIds が空なら入力と同値） */
  plan: PlanState;
  /** このターンで新たに✓したマイルストーン id（順） */
  completedIds: string[];
  /** 全マイルストーンが完了したか（length>0 が前提） */
  allDone: boolean;
};

/** current が指す未完マイルストーン。current が無効/完了済みなら先頭の未完を返す。 */
function activeMilestone(plan: PlanState): Milestone | undefined {
  const byCurrent = plan.milestones.find((m) => m.id === plan.current);
  if (byCurrent && !byCurrent.done) return byCurrent;
  return plan.milestones.find((m) => !m.done);
}

function firstUndone(plan: PlanState): string | null {
  return plan.milestones.find((m) => !m.done)?.id ?? null;
}

/** 1マイルストーンが成果物の中で達成されているかを狭く二値判定する。失敗時は false（誤✓を避ける）。 */
async function judgeSatisfied(
  llm: LlmClient,
  args: { goal: string; milestoneText: string; worksBody: string },
): Promise<boolean> {
  const format = planMilestoneJudgeJsonSchema as Record<string, unknown>;
  const raw = await llm.chat(
    [
      { role: "system", content: PLAN_MILESTONE_JUDGE_SYSTEM },
      {
        role: "user",
        content: [
          args.goal ? `計画の目標: ${args.goal}` : "",
          `判定するマイルストーン: ${args.milestoneText}`,
          "",
          "これまでに作られた成果物:",
          args.worksBody.trim() ? args.worksBody : "（まだ何も作られていない）",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    { format, temperature: 0 },
  );
  const parsed = tryParseJsonWithSchema(raw, planMilestoneJudgeSchema);
  return parsed.ok ? parsed.value.satisfied : false;
}

/**
 * plan processor（前判定・集中の背骨）。
 * 成果物(works)と計画を突き合わせ、current から前に向かって「実際に満たされた」マイルストーンを
 * 機械が✓して current を進める。stuck ポインタを毎ターン頭で実態に合わせる＝書く人が常に正しい所を書く。
 * 全✓になったら達成ログを1回足し allDone=true を返す（呼び出し側が集中を締める）。
 *
 * LLM の仕事は「このマイルストーンは成果物の中で達成されたか」の狭い二値だけ（分割統治）。
 * 構造の更新（✓・current 前進・達成ログ）はこの関数が決定的に行う。
 */
export async function runPlanProcessor(
  llm: LlmClient,
  input: { plan: PlanState; worksBody: string },
): Promise<PlanProcessorResult> {
  const plan: PlanState = {
    ...input.plan,
    milestones: input.plan.milestones.map((m) => ({ ...m })),
    log: [...input.plan.log],
  };
  const completedIds: string[] = [];

  if (plan.milestones.length === 0) {
    return { plan: input.plan, completedIds, allDone: false };
  }

  // current から前へ。満たされていれば✓して次へ、満たされない最初のところで止まる。
  // 上限はマイルストーン数（無限ループ防止）。
  for (let i = 0; i < plan.milestones.length; i++) {
    const m = activeMilestone(plan);
    if (!m) break; // 全部 done
    const satisfied = await judgeSatisfied(llm, {
      goal: plan.goal,
      milestoneText: m.text,
      worksBody: input.worksBody,
    });
    if (!satisfied) {
      plan.current = m.id; // 実態に合わせて current を未完の先頭へ
      break;
    }
    m.done = true;
    completedIds.push(m.id);
    plan.current = firstUndone(plan);
  }

  if (completedIds.length === 0) {
    return { plan: input.plan, completedIds, allDone: false };
  }

  const allDone = plan.milestones.every((m) => m.done);
  if (allDone) {
    plan.current = null;
    const wasDone = input.plan.milestones.length > 0 && input.plan.milestones.every((m) => m.done);
    if (!wasDone) {
      const date = new Date().toISOString().slice(0, 10);
      plan.log = [...plan.log, { date, text: `ゴール「${plan.title}」を達成` }];
    }
  }
  plan.updatedAt = new Date().toISOString();

  return { plan, completedIds, allDone };
}
