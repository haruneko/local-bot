// 横断 embedding（音/絵/文字を 1 空間）の窓口。
// LlmClient と同じ思想で backend を差し替え可能にする。呼ぶ側は backend を知らない。
// ImageBind（1024 次元・Docker HTTP 常駐）が本線。無効/未設定/落ちている時は null を返す
// ＝横断チャンネルをただスキップする degrade（OFF＝そのまま今の nomic だけ挙動）。
// 設計: docs/ARCH-NEXT.md「横断 embedding の設計（dual-vector・実装手前）」

/** ImageBind の埋め込み次元。横断テーブルの schema もこれに揃える。 */
export const XMODAL_DIM = 1024;

export type XmodalInput =
  | { kind: "text"; text: string }
  | { kind: "image"; imageBase64: string }
  | { kind: "audio"; audioBase64: string };

export interface XmodalEmbedder {
  /** 横断空間（ImageBind 1024）に埋め込む。無効/失敗時は null（degrade）。 */
  embed(input: XmodalInput): Promise<number[] | null>;
  /** 横断が有効か。false なら recall 側は横断チャンネルを引かない・符号化も横断列を書かない。 */
  readonly enabled: boolean;
}

/** 横断オフ（既定）。常に null＝今の nomic だけ挙動。 */
export class NullXmodalEmbedder implements XmodalEmbedder {
  readonly enabled = false;
  async embed(): Promise<number[] | null> {
    return null;
  }
}

export type ImageBindClientConfig = {
  /** 例: http://localhost:8800 */
  host: string;
  /** 1 リクエストのタイムアウト ms（未設定 10000）。落ちてたら待たずに null へ倒す。 */
  timeoutMs?: number;
};

/**
 * ImageBind HTTP 常駐サービスのクライアント。
 * `POST {host}/embed` に {modality, data} を投げ {vector:number[]} を受ける。
 * どんな失敗（接続不可・タイムアウト・非 200・空ベクトル）でも **throw せず null**＝degrade。
 */
export class ImageBindClient implements XmodalEmbedder {
  readonly enabled = true;
  private readonly host: string;
  private readonly timeoutMs: number;

  constructor(config: ImageBindClientConfig) {
    this.host = config.host.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 10000;
  }

  async embed(input: XmodalInput): Promise<number[] | null> {
    const body =
      input.kind === "text"
        ? { modality: "text", data: input.text }
        : input.kind === "image"
          ? { modality: "vision", data: stripDataUrl(input.imageBase64) }
          : { modality: "audio", data: stripDataUrl(input.audioBase64) };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.host}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { vector?: unknown };
      const vec = json.vector;
      if (!Array.isArray(vec) || vec.length === 0) return null;
      if (!vec.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
      return vec as number[];
    } catch {
      // 接続不可・タイムアウト・JSON 不正など全部 degrade
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** "data:image/jpeg;base64,XXXX" でも素の base64 でも、base64 本体だけ返す。 */
function stripDataUrl(s: string): string {
  const comma = s.indexOf(",");
  return s.startsWith("data:") && comma >= 0 ? s.slice(comma + 1) : s;
}

export type XmodalConfig = {
  enabled?: boolean;
  host?: string;
  timeoutMs?: number;
};

/** 設定から横断 embedder を作る。無効/host 未設定なら Null（OFF）。 */
export function createXmodalEmbedder(config?: XmodalConfig): XmodalEmbedder {
  if (!config?.enabled || !config.host?.trim()) {
    return new NullXmodalEmbedder();
  }
  return new ImageBindClient({ host: config.host.trim(), timeoutMs: config.timeoutMs });
}
