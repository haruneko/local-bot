export const ACTION_KINDS = [
  "none",
  "memory",
  "research",
  "express",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export type TimeRange = {
  sinceDaysAgo?: number;
  untilDaysAgo?: number;
};

export type AbstractAction = {
  kind: ActionKind;
  intent: string;
  timeRange?: TimeRange;
};

export const NONE_ACTION: AbstractAction = { kind: "none", intent: "" };

export function isActionAttempted(action: AbstractAction): boolean {
  return action.kind !== "none";
}

export function formatActionMeta(action: AbstractAction): string {
  if (action.kind === "none") return "";
  if (!action.intent.trim()) return action.kind;
  return `${action.kind}: ${action.intent}`;
}

export function actionLabelJa(kind: ActionKind): string {
  switch (kind) {
    case "none":
      return "何もしない";
    case "memory":
      return "記憶";
    case "research":
      return "探索";
    case "express":
      return "発信";
  }
}
