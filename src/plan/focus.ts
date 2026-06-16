import type { PlanState } from "./state.js";

/**
 * 計画の「進捗値」。完了したマイルストーン数＋ログ数。
 * 進捗ベース卒業（達成不能goalの見限り）の停滞判定に使う。
 * マイルストーン完了＝前進、過去形ログの追記＝何かやった痕跡、の両方を前進とみなす。
 */
export function planProgress(p: PlanState): number {
  return p.milestones.filter((m) => m.done).length + p.log.length;
}

export type FocusGraduation = {
  /** 次の停滞カウント */
  stall: number;
  /** 次に記憶する最高進捗 */
  baseline: number;
  /** この集中ターンで卒業（見限り）が成立したか */
  graduated: boolean;
};

/**
 * 進捗ベース卒業の判定（純関数）。集中して取り組んでいるターンで呼ぶ。
 * 進捗が baseline を超えていれば前進＝停滞リセット。超えなければ停滞を積み、
 * maxStall に達したら卒業（graduated=true・呼び出し側が plan を retired にして手放す）。
 *
 * focusStreak（連続集中の疲労＝休む）とは別物：こちらは「進捗が無い目標を見限る」。
 */
export function evaluateFocusGraduation(args: {
  progress: number;
  stall: number;
  baseline: number;
  maxStall: number;
}): FocusGraduation {
  if (args.progress > args.baseline) {
    return { stall: 0, baseline: args.progress, graduated: false };
  }
  const stall = args.stall + 1;
  if (stall >= args.maxStall) {
    return { stall: 0, baseline: 0, graduated: true };
  }
  return { stall, baseline: args.baseline, graduated: false };
}
