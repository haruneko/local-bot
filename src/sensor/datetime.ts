export function formatRelativeTime(createdAt: string, now: Date): string {
  const diffMs = now.getTime() - Date.parse(createdAt);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 2) return "さっき";
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

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

/** timeZone での時（0〜23）を取り出す */
function localHour(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).format(now);
  const n = Number.parseInt(h, 10);
  return Number.isNaN(n) ? 0 : n === 24 ? 0 : n;
}

/**
 * 時刻を人間の時間感覚の言葉（相）に変換する。生の時刻だけだとモデルが「感じ」へ変換できず
 * 効かないため、相を先に付けてやる（docs の時間感覚メモ参照）。
 * いまは決定的テーブルだが、本来は機微のためミニ LLM に差し替えてもよい層（構造はここで固定）。
 */
export function phaseOfDay(now: Date, timeZone = "Asia/Tokyo"): string {
  const h = localHour(now, timeZone);
  if (h < 4) return "未明";
  if (h < 7) return "明け方";
  if (h < 11) return "朝";
  if (h < 15) return "昼";
  if (h < 18) return "夕方";
  if (h < 22) return "夜";
  return "夜更け";
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
  // 生の日時＋曜日（datePart に含む）＋時間感覚の言葉（相）。起動間の差分は人間も持たないので入れない。
  return `${datePart} ${timePart}（${tz}） ／ ${phaseOfDay(now, timeZone)}`;
}
