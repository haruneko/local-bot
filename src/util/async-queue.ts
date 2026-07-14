/**
 * push/end で駆動する単一プロデューサ・単一コンシューマの非同期キュー。
 *
 * プロデューサ（発話生成ループ）が push で値を積み、end で打ち切る。
 * コンシューマ（出力チャンネル）は for-await で消費し、end で反復が終わる。
 * push が消費より先行しても値はバッファに溜まり、順序どおりに届く。
 * end 後の push は無視する（発話生成の遅延コールバックが端に落ちても壊さない）。
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private ended = false;
  /** 空のときに next() を待たせている resolver（あれば1個） */
  private pending: ((r: IteratorResult<T>) => void) | null = null;

  /** 値を積む。end 済みなら無視する。 */
  push(value: T): void {
    if (this.ended) return;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  /** これ以上値が来ないことを通知する。待っている消費者を終端で起こす。 */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.pending = resolve;
        });
      },
    };
  }
}
