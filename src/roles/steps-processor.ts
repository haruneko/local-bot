import { tryParseJsonWithSchema } from "../action/parse-json.js";
import { STEPS_MILESTONE_JUDGE_SYSTEM } from "../prompts/roles.js";
import {
  stepsMilestoneJudgeJsonSchema,
  stepsMilestoneJudgeSchema,
} from "../prompts/schemas.js";
import type { LlmClient } from "../llm/types.js";
import type { Milestone, StepsState } from "../steps/state.js";

export type StepsProcessorResult = {
  /** 更新後の計画（completedIds が空なら入力と同値） */
  steps: StepsState;
  /** このターンで新たに✓したマイルストーン id（順） */
  completedIds: string[];
  /** 全マイルストーンが完了したか（length>0 が前提） */
  allDone: boolean;
};

/** current が指す未完マイルストーン。current が無効/完了済みなら先頭の未完を返す。 */
function activeMilestone(steps: StepsState): Milestone | undefined {
  const byCurrent = steps.milestones.find((m) => m.id === steps.current);
  if (byCurrent && !byCurrent.done) return byCurrent;
  return steps.milestones.find((m) => !m.done);
}

function firstUndone(steps: StepsState): string | null {
  return steps.milestones.find((m) => !m.done)?.id ?? null;
}

/** 1マイルストーンが「実際にやれたか」を狭く二値判定する。失敗時は false（誤✓を避ける）。
 *  根拠は今回の行動の実結果＋これまでの成果物。意図・宣言・捏造では true にしない。 */
async function judgeSatisfied(
  llm: LlmClient,
  args: { goal: string; milestoneText: string; worksBody: string; actionResults: string },
): Promise<boolean> {
  const format = stepsMilestoneJudgeJsonSchema as Record<string, unknown>;
  const raw = await llm.chat(
    [
      { role: "system", content: STEPS_MILESTONE_JUDGE_SYSTEM },
      {
        role: "user",
        content: [
          args.goal ? `目標：${args.goal}` : "",
          `現在のマイルストーン：${args.milestoneText}`,
          "",
          "今回やったこと（行動の結果。失敗・空振りはやれていない）：",
          args.actionResults.trim() ? args.actionResults : "（このターンでは何も起きていない）",
          "",
          "成果物：",
          args.worksBody.trim() ? args.worksBody : "（まだ何も作られていない）",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    { format, temperature: 0 },
  );
  const parsed = tryParseJsonWithSchema(raw, stepsMilestoneJudgeSchema);
  return parsed.ok ? parsed.value.satisfied : false;
}

/**
 * steps processor（受け入れ判定・集中の背骨）。**実行のあと・結果を受けて**回す。
 * 今回の行動の実結果（actionResults）＋これまでの成果物(works)を根拠に、current から前へ
 * 「実際にやれたマイルストーン」を機械が✓して current を進める。失敗・空振りなら進めない（作話防止）。
 * 全✓になったら達成ログを1回足し allDone=true を返す（呼び出し側が集中を締める）。
 *
 * LLM の仕事は「このマイルストーンは実際にやれたか」の狭い二値だけ（doer とは別人格＝やった本人に
 * 合否を出させない）。構造の更新（✓・current 前進・達成ログ）はこの関数が決定的に行う。
 */
export async function runStepsProcessor(
  llm: LlmClient,
  input: { steps: StepsState; worksBody: string; actionResults: string },
): Promise<StepsProcessorResult> {
  const steps: StepsState = {
    ...input.steps,
    milestones: input.steps.milestones.map((m) => ({ ...m })),
    log: [...input.steps.log],
  };
  const completedIds: string[] = [];

  if (steps.milestones.length === 0) {
    return { steps: input.steps, completedIds, allDone: false };
  }

  // current から前へ。満たされていれば✓して次へ、満たされない最初のところで止まる。
  // 上限はマイルストーン数（無限ループ防止）。
  for (let i = 0; i < steps.milestones.length; i++) {
    const m = activeMilestone(steps);
    if (!m) break; // 全部 done
    const satisfied = await judgeSatisfied(llm, {
      goal: steps.goal,
      milestoneText: m.text,
      worksBody: input.worksBody,
      actionResults: input.actionResults,
    });
    if (!satisfied) {
      steps.current = m.id; // 実態に合わせて current を未完の先頭へ
      break;
    }
    m.done = true;
    completedIds.push(m.id);
    steps.current = firstUndone(steps);
  }

  if (completedIds.length === 0) {
    return { steps: input.steps, completedIds, allDone: false };
  }

  const allDone = steps.milestones.every((m) => m.done);
  if (allDone) {
    steps.current = null;
    const wasDone = input.steps.milestones.length > 0 && input.steps.milestones.every((m) => m.done);
    if (!wasDone) {
      const date = new Date().toISOString().slice(0, 10);
      steps.log = [...steps.log, { date, text: `ゴール「${steps.title}」を達成` }];
    }
  }
  steps.updatedAt = new Date().toISOString();

  return { steps, completedIds, allDone };
}
