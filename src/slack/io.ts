/**
 * Slack アダプタの I/O 部品。cli/slack.ts の main() closure から切り出してテスト可能にした。
 * Bolt / fetch は注入で受ける（LLM 統合テストを持たない方針と同じくフェイクで固定する）。
 */

export type SlackFile = {
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
};

export type SlackImageDeps = {
  botToken: string;
  /** 画像正規化（sensor/image の normalizeImage）。長辺上限は呼び出し側で束ねて渡す */
  normalize: (rawBase64: string) => Promise<string>;
  fetchFn?: typeof fetch;
};

/**
 * Slack の添付画像を bot トークンで DL → base64（文字起こししない・生のまま image_feed へ）。
 * files:read スコープが無い/DL 失敗時はその画像だけスキップ＝テキストとして続行（壊さない）。
 * スキップは黙殺しない＝stderr に一行残す（無いはずの画像が無い、をデバッグ可能に）。
 */
export async function downloadSlackImages(
  files: SlackFile[] | undefined,
  deps: SlackImageDeps,
): Promise<string[]> {
  if (!files?.length || !deps.botToken) return [];
  const fetchFn = deps.fetchFn ?? fetch;
  const out: string[] = [];
  for (const f of files) {
    if (!f.mimetype?.startsWith("image/")) continue;
    const url = f.url_private_download ?? f.url_private;
    if (!url) continue;
    try {
      const res = await fetchFn(url, {
        headers: { Authorization: `Bearer ${deps.botToken}` },
      });
      if (!res.ok) {
        console.error(`[slack] 画像DLをスキップ (HTTP ${res.status})`);
        continue;
      }
      const raw = Buffer.from(await res.arrayBuffer()).toString("base64");
      out.push(await deps.normalize(raw));
    } catch (err) {
      console.error(
        `[slack] 画像DLをスキップ (${err instanceof Error ? err.message : err})`,
      );
    }
  }
  return out;
}

/** これを超える成果物は inline で流さず Slack snippet（折りたたみ添付）にする */
export const ARTIFACT_INLINE_MAX = 1200;

export type ArtifactPoster = {
  postMessage: (channel: string, text: string) => Promise<unknown>;
  uploadSnippet: (channel: string, content: string) => Promise<unknown>;
};

/**
 * 成果物の投稿: 短いものは通常メッセージ、長いものは snippet でチャットを流さない。
 * snippet 失敗時は通常投稿にフォールバック。二重に失敗しても throw しない＝
 * 出力効果器の失敗でターンを殺さない（say は orchestrator.run の中＝throw すると
 * 内省・エピソード永続化まで巻き添えで飛ぶ）。
 */
export async function postArtifact(
  channel: string,
  text: string,
  poster: ArtifactPoster,
): Promise<void> {
  try {
    if (text.length <= ARTIFACT_INLINE_MAX) {
      await poster.postMessage(channel, text);
      return;
    }
    try {
      await poster.uploadSnippet(channel, text);
    } catch {
      await poster.postMessage(channel, text);
    }
  } catch (err) {
    console.error(
      `[slack] 成果物の投稿に失敗（ターンは続行）: ${err instanceof Error ? err.message : err}`,
    );
  }
}
