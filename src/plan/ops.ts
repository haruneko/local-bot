import type { Milestone, PlanState } from "./state.js";
import { planSlug } from "./state.js";

/**
 * LLM が出す「小さな操作」。構造はコードが握り、LLM は op の選択と中身の一文だけ出す。
 * Ollama structured output 向けに discriminated union でなく平坦にする（意味は applier が解釈）。
 */
export type PlanOp = {
  op:
    | "new_goal"
    | "activate"
    | "shelve"
    | "retire"
    | "complete"
    | "reopen"
    | "set_current"
    | "add_milestone"
    | "log"
    | "noop";
  /** 対象の計画 id（省略時 = focusPlan）。new_goal では無視（生成する） */
  planId?: string;
  /** new_goal のみ: true で作って即開始 */
  activate?: boolean;
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
    case "retire": {
      next.retired = true;
      next.log.push({ date: isoDate(now), text: `「${next.title}」を見限った` });
      break;
    }
    case "activate": {
      // 開始/再開: focusPlan の付け替えは orchestrator が行う。ここでは current が空なら
      // 未完の先頭へ戻す（再開時に取り組む対象を確定）。構造の変更はそれだけ。
      if (!next.current) next.current = next.milestones.find((m) => !m.done)?.id ?? null;
      if (next.retired) next.retired = false; // 再開＝見限り解除
      break;
    }
    case "shelve": {
      // 棚上げ: focusPlan から外すのは orchestrator。plan 自体は active のまま残す。
      next.log.push({ date: isoDate(now), text: `「${next.title}」を棚上げした` });
      break;
    }
    case "noop":
    default:
      break;
  }

  return next;
}
