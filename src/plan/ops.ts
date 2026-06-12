import type { Milestone, PlanState } from "./state.js";
import { planSlug } from "./state.js";

/**
 * LLM が出す「小さな操作」。構造はコードが握り、LLM は op の選択と中身の一文だけ出す。
 * Ollama structured output 向けに discriminated union でなく平坦にする（意味は applier が解釈）。
 */
export type PlanOp = {
  op:
    | "new_goal"
    | "complete"
    | "reopen"
    | "set_current"
    | "add_milestone"
    | "log"
    | "noop";
  id?: string;
  text?: string;
  title?: string;
  goal?: string;
  milestones?: string[];
};

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function nextMilestoneId(state: PlanState): string {
  const ids = new Set(state.milestones.map((m) => m.id));
  let n = state.milestones.length + 1;
  while (ids.has(`m${n}`)) n++;
  return `m${n}`;
}

/**
 * op を現 state に決定的に適用する純関数。LLM は一切呼ばない。
 * new_goal は新規 state を返す。それ以外は既存 state が必要（なければ null）。
 */
export function applyPlanOp(
  state: PlanState | null,
  op: PlanOp,
  now: Date,
): PlanState | null {
  const iso = now.toISOString();

  if (op.op === "new_goal") {
    const title = (op.title ?? "").trim() || "無題のゴール";
    const milestones: Milestone[] = (op.milestones ?? [])
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text, i) => ({ id: `m${i + 1}`, text, done: false }));
    return {
      id: planSlug(title),
      title,
      goal: (op.goal ?? "").trim(),
      milestones,
      current: milestones[0]?.id ?? null,
      log: [{ date: isoDate(now), text: `ゴール「${title}」を作成` }],
      createdAt: iso,
      updatedAt: iso,
    };
  }

  if (!state) return null; // 以降の op は既存 plan が前提

  const next: PlanState = {
    ...state,
    milestones: state.milestones.map((m) => ({ ...m })),
    log: [...state.log],
    updatedAt: iso,
  };

  switch (op.op) {
    case "complete": {
      const m = next.milestones.find((x) => x.id === op.id);
      if (m) {
        m.done = true;
        if (next.current === m.id) {
          next.current = next.milestones.find((x) => !x.done)?.id ?? null;
        }
      }
      break;
    }
    case "reopen": {
      const m = next.milestones.find((x) => x.id === op.id);
      if (m) m.done = false;
      break;
    }
    case "set_current": {
      if (next.milestones.some((x) => x.id === op.id)) next.current = op.id ?? null;
      break;
    }
    case "add_milestone": {
      const text = (op.text ?? "").trim();
      if (text) {
        const id = nextMilestoneId(next);
        next.milestones.push({ id, text, done: false });
        if (!next.current) next.current = id;
      }
      break;
    }
    case "log": {
      const text = (op.text ?? "").trim();
      if (text) next.log.push({ date: isoDate(now), text });
      break;
    }
    case "noop":
    default:
      break;
  }

  return next;
}
