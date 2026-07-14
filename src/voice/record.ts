/**
 * マイク録音: parecord（pulseaudio-utils）を spawn して wav を取得する。
 *
 * - 16kHz mono s16le wav（STT 必須フォーマット）で一時ファイルに録音。
 * - stop() で SIGINT を送ってプロセス終了を待ち、wav を読んで一時ファイルを削除。
 * - parecord が PATH にない場合は startRecording が分かりやすいメッセージで throw。
 *
 * DI: spawn と hasParecord チェック関数を外から注入できる（テスト用）。
 */

import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
} from "node:child_process";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SpawnFn = (cmd: string, args: string[], opts?: any) => ChildProcess;

/** parecord が利用可能かチェックする関数（テスト用 DI） */
export type CheckParecordFn = () => boolean;

export type RecordingHandle = {
  /** 録音を停止して wav バッファを返す。一時ファイルは削除される。 */
  stop(): Promise<Buffer>;
};

/** デフォルトの parecord 存在チェック（which を spawnSync で確認） */
export function defaultCheckParecord(): boolean {
  const result = nodeSpawnSync("which", ["parecord"], { stdio: "ignore" });
  return result.status === 0;
}

/**
 * 録音を開始する。
 * @param path          wav の書き込み先パス
 * @param _spawn        テスト用 spawn 差し替え（省略時は node:child_process の spawn）
 * @param _checkParecord テスト用 parecord チェック差し替え
 */
export function startRecording(
  path: string,
  _spawn: SpawnFn = nodeSpawn,
  _checkParecord: CheckParecordFn = defaultCheckParecord,
): RecordingHandle {
  // parecord が PATH にあるかを確認
  if (!_checkParecord()) {
    throw new Error(
      "parecord が見つかりません。pulseaudio-utils を入れてください: sudo apt-get install -y pulseaudio-utils",
    );
  }

  const child = _spawn(
    "parecord",
    [
      "--format=s16le",
      "--rate=16000",
      "--channels=1",
      "--file-format=wav",
      path,
    ],
    { stdio: "ignore" },
  );

  return {
    async stop(): Promise<Buffer> {
      // SIGINT で parecord を正常終了させる（SIGTERM だと wav ヘッダが壊れることがある）
      child.kill("SIGINT");

      // プロセス終了を待つ
      await new Promise<void>((resolve) => {
        // すでに終了していた場合
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.on("close", () => resolve());
      });

      // wav 読み込み
      const buf = await readFile(path);

      // 一時ファイル削除（失敗しても無視）
      unlink(path).catch(() => undefined);

      return buf;
    },
  };
}

/**
 * 録音に使う一時ファイルパスを生成する。
 */
export function makeTempWavPath(): string {
  return join(tmpdir(), `local-bot-rec-${randomUUID()}.wav`);
}
