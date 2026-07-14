/**
 * 音声出力チャンネル（口の効果器の音声ラッパー）。
 *
 * - say(): speech があれば先に print してから読み上げキューへ積む。
 *   artifacts は printArtifact のみ（音声では出さない）。
 * - speakSentence(): 後続ストリーミング配線用。キューに積むだけ。
 * - flush(): キューが空になるまで待つ（単発 CLI がプロセス終了前に呼ぶ）。
 * - degrade: synthesize/play が throw したら stderr に1行出してスキップ。
 *   テキスト表示は必ず先に行う（音声が死んでも会話は死なない）。
 */

import type { OutputChannel } from "../orchestrator/turn.js";
import { synthesizeVoice } from "./voicevox.js";
import { playWav } from "./play.js";

export type VoiceOutputChannelOpts = {
  print: (text: string) => void;
  printArtifact: (text: string) => void;
  voice: { host: string; speaker: number };
  /** DI 用: テストで差し替える synthesize 実装 */
  _synthesize?: (text: string, cfg: { host: string; speaker: number }) => Promise<Buffer>;
  /** DI 用: テストで差し替える play 実装 */
  _play?: (wav: Buffer) => Promise<void>;
};

export type VoiceOutputChannel = OutputChannel & {
  /** 後続ストリーミング配線用: キューに積むだけ（say を経由しない文を追加できる） */
  speakSentence(text: string): void;
  /** キューが空になるまで待つ（単発 CLI がプロセス終了前に呼ぶ） */
  flush(): Promise<void>;
};

export function createVoiceOutputChannel(
  opts: VoiceOutputChannelOpts,
): VoiceOutputChannel {
  const { print, printArtifact, voice } = opts;
  const synth = opts._synthesize ?? synthesizeVoice;
  const play = opts._play ?? playWav;

  // 読み上げキュー: Promise チェーンで直列化
  let queue: Promise<void> = Promise.resolve();

  function enqueue(text: string): void {
    queue = queue.then(async () => {
      try {
        const wav = await synth(text, voice);
        await play(wav);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[voice] 読み上げ失敗（text は表示済み）: ${msg}\n`,
        );
      }
    });
  }

  return {
    say(speech: string | null, artifacts: string[]): void {
      // テキスト表示は必ず先
      if (speech) {
        print(speech);
        enqueue(speech);
      }
      for (const artifact of artifacts) {
        printArtifact(`\n${artifact}`);
        // artifacts は読み上げない（仕様）
      }
    },

    async sayStream(
      sentences: AsyncIterable<string>,
      artifacts: string[],
    ): Promise<void> {
      // 生成中の文を逐次: テキスト表示 → 読み上げキューへ積む（say と同じ順序＝表示が先）。
      for await (const sentence of sentences) {
        if (!sentence) continue;
        print(sentence);
        enqueue(sentence);
      }
      // 成果物は文の流し込みが終わってから（say と同様・読み上げない）。
      for (const artifact of artifacts) {
        printArtifact(`\n${artifact}`);
      }
    },

    speakSentence(text: string): void {
      enqueue(text);
    },

    flush(): Promise<void> {
      // 現在のキューの末尾を捕捉しておき、それが終わるまで待つ
      const tail = queue;
      return tail;
    },
  };
}
