/** ターン実行時点の日時（揮発コンテキスト用） */
export type ContextClock = {
  /** ISO8601（機械用） */
  executedAt: string;
  /** 日本語表示（LLM 向け） */
  currentDateTime: string;
};

export function buildContextClock(
  now: Date = new Date(),
  timeZone = "Asia/Tokyo",
): ContextClock {
  return {
    executedAt: now.toISOString(),
    currentDateTime: formatContextDateTime(now, timeZone),
  };
}

export function formatContextDateTime(now: Date, timeZone: string): string {
  const datePart = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(now);
  const timePart = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const tz =
    timeZone === "Asia/Tokyo" ? "JST" : timeZone.replace(/_/g, " ");
  return `${datePart} ${timePart}（${tz}）`;
}
