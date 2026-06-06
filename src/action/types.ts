export const ACTION_KINDS = [
  "none",
  "remember",
  "recall",
  "memo_write",
  "memo_read",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export type AbstractAction = {
  kind: ActionKind;
  intent: string;
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
    case "remember":
      return "覚えておく";
    case "recall":
      return "思い出す";
    case "memo_write":
      return "メモを書く";
    case "memo_read":
      return "メモを読む";
  }
}
