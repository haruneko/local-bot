import type { ActionOutcome } from "../types.js";
import type { StepsState } from "./state.js";

/**
 * 計画の「進捗値」。完了したマイルストーン数＋ログ数。
 * 進捗ベース卒業（達成不能goalの見限り）の停滞判定に使う。
 * マイルストーン完了＝前進、過去形ログの追記＝何かやった痕跡、の両方を前進とみなす。
 */
export function stepsProgress(p: StepsState): number {
  return p.milestones.filter((m) => m.done).length + p.log.length;
}

/** actor 実行後の focusSteps 遷移を決める入力（手の意図と達成シグナル）。 */
export type FocusActionSignals = {
  /** いまの focusSteps（空＝集中対象なし） */
  current: string;
  /** この計画は達成/完了したか（steps actor の achieved・受け入れ判定の全✓・畳みのいずれか） */
  achievedOrCompleted: boolean;
  /** steps actor が activate した計画 id（無ければ空） */
  activateStepsId: string;
  /** steps actor が shelve/retire した計画 id（無ければ空） */
  setAsideStepsId: string;
};

/**
 * actor 実行後の focusSteps を決める純関数。優先順位を1箇所に集約する：
 *   1. 達成/完了 → 手放す（最優先・activate より勝つ＝達成したターンに掴み直さない）
 *   2. 明示 activate → その計画を集中に（乗り換え/起立）
 *   3. いまの集中を shelve/retire → 手放す（対象が現 focus のときだけ）
 *   4. それ以外 → 現状維持
 * 入口で塞ぐ dispatcher none・畳み（alreadyDone/retired）・疲労ギプス・進捗卒業は
 * フェーズ依存の別ステップ（呼び出し側で setFocusSteps を通す）。
 */
export function resolveFocusAfterActions(s: FocusActionSignals): string {
  if (s.achievedOrCompleted) return "";
  if (s.activateStepsId) return s.activateStepsId;
  if (s.setAsideStepsId && s.current === s.setAsideStepsId) return "";
  return s.current;
}

export type StepsActionSignals = {
  /** steps actor が achieved を立てたか */
  achieved: boolean;
  /** steps actor が activate した計画 id（無ければ空） */
  activateStepsId: string;
  /** steps actor が shelve/retire した計画 id（無ければ空） */
  setAsideStepsId: string;
};

/**
 * actor 結果から steps の手のシグナル（達成・activate・shelve/retire）を拾う純関数。
 * focusSteps の付け替えは steps facts.action（手の意図）で決める＝「計画を作った/触った＝集中」
 * でなく「明示 activate で開始」。うっかり集中を防ぐ。結果は resolveFocusAfterActions が消費する。
 */
export function collectStepsActionSignals(
  actions: readonly ActionOutcome[],
): StepsActionSignals {
  const signals: StepsActionSignals = {
    achieved: false,
    activateStepsId: "",
    setAsideStepsId: "",
  };
  for (const a of actions) {
    if (a.attempted && a.status === "succeeded" && a.facts?.kind === "steps") {
      if (a.facts.achieved) signals.achieved = true;
      if (a.facts.action === "activate") signals.activateStepsId = a.facts.stepsId;
      else if (a.facts.action === "shelve" || a.facts.action === "retire") {
        signals.setAsideStepsId = a.facts.stepsId;
      }
    }
  }
  return signals;
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
 * maxStall に達したら卒業（graduated=true・呼び出し側が steps を retired にして手放す）。
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
