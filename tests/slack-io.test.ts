import { describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_INLINE_MAX,
  downloadSlackImages,
  postArtifact,
  type ArtifactPoster,
  type SlackFile,
} from "../src/slack/io.js";

const normalize = async (raw: string) => `norm:${raw}`;

function fetchOk(body = "img-bytes"): typeof fetch {
  return vi.fn(async () =>
    new Response(Buffer.from(body), { status: 200 }),
  ) as unknown as typeof fetch;
}

describe("downloadSlackImages", () => {
  const imageFile: SlackFile = {
    mimetype: "image/png",
    url_private_download: "https://files.slack.com/a.png",
  };

  it("画像を DL して normalize した base64 を返す", async () => {
    const out = await downloadSlackImages([imageFile], {
      botToken: "xoxb-test",
      normalize,
      fetchFn: fetchOk("abc"),
    });
    expect(out).toEqual([`norm:${Buffer.from("abc").toString("base64")}`]);
  });

  it("bot トークンが無ければ何もしない", async () => {
    const fetchFn = fetchOk();
    const out = await downloadSlackImages([imageFile], {
      botToken: "",
      normalize,
      fetchFn,
    });
    expect(out).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("画像以外の mimetype と URL 無しはスキップ", async () => {
    const out = await downloadSlackImages(
      [
        { mimetype: "text/plain", url_private: "https://x/t.txt" },
        { mimetype: "image/png" },
      ],
      { botToken: "xoxb-test", normalize, fetchFn: fetchOk() },
    );
    expect(out).toEqual([]);
  });

  it("HTTP エラー（スコープ未付与等）はその画像だけスキップして続行", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(new Response(Buffer.from("ok"), { status: 200 }));
    const out = await downloadSlackImages([imageFile, imageFile], {
      botToken: "xoxb-test",
      normalize,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(out).toEqual([`norm:${Buffer.from("ok").toString("base64")}`]);
  });

  it("fetch が throw してもターンを壊さない（空スキップ）", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const out = await downloadSlackImages([imageFile], {
      botToken: "xoxb-test",
      normalize,
      fetchFn,
    });
    expect(out).toEqual([]);
  });
});

describe("postArtifact", () => {
  function poster(over: Partial<ArtifactPoster> = {}): {
    poster: ArtifactPoster;
    postMessage: ReturnType<typeof vi.fn>;
    uploadSnippet: ReturnType<typeof vi.fn>;
  } {
    const postMessage = vi.fn(async () => ({}));
    const uploadSnippet = vi.fn(async () => ({}));
    return {
      poster: { postMessage, uploadSnippet, ...over },
      postMessage,
      uploadSnippet,
    };
  }

  it("短い成果物は通常メッセージで送る", async () => {
    const { poster: p, postMessage, uploadSnippet } = poster();
    await postArtifact("C1", "短い", p);
    expect(postMessage).toHaveBeenCalledWith("C1", "短い");
    expect(uploadSnippet).not.toHaveBeenCalled();
  });

  it("長い成果物は snippet で送る（チャットを流さない）", async () => {
    const { poster: p, postMessage, uploadSnippet } = poster();
    const long = "あ".repeat(ARTIFACT_INLINE_MAX + 1);
    await postArtifact("C1", long, p);
    expect(uploadSnippet).toHaveBeenCalledWith("C1", long);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("snippet 失敗時は通常投稿にフォールバック", async () => {
    const { poster: p, postMessage } = poster({
      uploadSnippet: vi.fn(async () => {
        throw new Error("files:write missing");
      }),
    });
    const long = "あ".repeat(ARTIFACT_INLINE_MAX + 1);
    await postArtifact("C1", long, p);
    expect(postMessage).toHaveBeenCalledWith("C1", long);
  });

  it("二重に失敗しても throw しない＝出力効果器の失敗でターンを殺さない", async () => {
    const failing: ArtifactPoster = {
      postMessage: async () => {
        throw new Error("slack down");
      },
      uploadSnippet: async () => {
        throw new Error("slack down");
      },
    };
    const long = "あ".repeat(ARTIFACT_INLINE_MAX + 1);
    await expect(postArtifact("C1", long, failing)).resolves.toBeUndefined();
    await expect(postArtifact("C1", "短い", failing)).resolves.toBeUndefined();
  });
});
