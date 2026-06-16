import path from "node:path";

/**
 * LanceDB（episodes / semantic / memo_index / episodes_xmodal）の保存先ルート。
 * テスト隔離・記憶プロファイル切替のため `LANCEDB_DIR` で差し替え可能（既定は `data/lancedb`）。
 * `MEMO_NOTES_DIR`（notes.ts）と同じ思想＝本物の記憶を汚さずに実機を回せる。
 */
export function lancedbDir(): string {
  return process.env.LANCEDB_DIR?.trim() || path.join(process.cwd(), "data", "lancedb");
}
