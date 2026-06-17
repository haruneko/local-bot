import { describe, expect, it } from "vitest";
import { generateDialogueSpeech } from "../src/roles/language-faculty.js";
import { createTurnContext, withPersona } from "../src/context/turn-context.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { LANGUAGE_HEARTBEAT_SYSTEM_PREFIX, LANGUAGE_SYSTEM_PREFIX } from "../src/prompts/roles.js";

const dialogue = { resolveUserDisplayName: (id: string) => id === "u1" ? "HAL" : id };

function makeHeartbeatCtx(priorTurns: Parameters<typeof createTurnContext>[0]["recentTurns"] = []) {
  return withPersona(
    createTurnContext({
      turnId: "t-hb",
      state: "静穏",
      trigger: { type: "heartbeat" },
      dialogue,
      recentTurns: priorTurns,
      recalledEpisodes: [],
    }),
    "キャラクター設定",
  );
}

function makeUserCtx(content = "こんにちは") {
  return withPersona(
    createTurnContext({
      turnId: "t-user",
      state: "対話",
      trigger: { type: "user_message", content, speakerId: "u1" },
      dialogue,
      recentTurns: [],
      recalledEpisodes: [],
    }),
    "キャラクター設定",
  );
}

describe("generateDialogueSpeech — heartbeat/dialogue 統一フォーマット", () => {
  it("heartbeat: システムプロンプトに LANGUAGE_HEARTBEAT_SYSTEM_PREFIX を使う", async () => {
    const llm = new FakeLlmClient(['{"speech":"独り言","nextState":"静穏"}']);
    await generateDialogueSpeech(llm, makeHeartbeatCtx());
    const sys = llm.calls[0].messages.find((m) => m.role === "system");
    expect(sys?.content).toContain(LANGUAGE_HEARTBEAT_SYSTEM_PREFIX.slice(0, 20));
    expect(sys?.content).not.toContain(LANGUAGE_SYSTEM_PREFIX.slice(0, 20));
  });

  it("user_message: システムプロンプトに LANGUAGE_SYSTEM_PREFIX を使う", async () => {
    const llm = new FakeLlmClient(['{"speech":"返答","nextState":"対話"}']);
    await generateDialogueSpeech(llm, makeUserCtx());
    const sys = llm.calls[0].messages.find((m) => m.role === "system");
    expect(sys?.content).toContain(LANGUAGE_SYSTEM_PREFIX.slice(0, 20));
  });

  it("heartbeat: 状況行に内部語『ハートビート』を出さない", async () => {
    const llm = new FakeLlmClient(['{"speech":""}']);
    await generateDialogueSpeech(llm, makeHeartbeatCtx());
    const sys = llm.calls[0].messages.find((m) => m.role === "system");
    expect(sys?.content).not.toContain("ハートビート");
  });

  it("heartbeat: prior の独り言が assistant メッセージとして届く", async () => {
    const llm = new FakeLlmClient(['{"speech":"","nextState":"静穏"}']);
    const ctx = makeHeartbeatCtx([
      { role: "user", speakerId: "u1", content: "調べておいて" },
      { role: "assistant", channel: "monologue", content: "〇〇を調べた。次は△△を見よう" },
    ]);
    await generateDialogueSpeech(llm, ctx);
    const msgs = llm.calls[0].messages;
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    expect(assistantMsgs.some((m) => m.content.includes("〇〇を調べた"))).toBe(true);
  });

  it("heartbeat: user ターンなしでも自分の独り言は assistant として届く（自己連続性）", async () => {
    const llm = new FakeLlmClient(['{"speech":"","nextState":"静穏"}']);
    // 静穏連続（user ターンなし）でも、エバ自身の直近の独り言を落とさない
    const ctx = makeHeartbeatCtx([
      { role: "assistant", channel: "monologue", content: "独り言だけ" },
    ]);
    await generateDialogueSpeech(llm, ctx);
    const msgs = llm.calls[0].messages;
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    expect(assistantMsgs.some((m) => m.content.includes("独り言だけ"))).toBe(true);
  });

  it("heartbeat: 最終メッセージが role:user で「（発話はなかった）」", async () => {
    const llm = new FakeLlmClient(['{"speech":""}']);
    await generateDialogueSpeech(llm, makeHeartbeatCtx());
    const msgs = llm.calls[0].messages;
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain("（発話はなかった）");
  });

  it("user_message: note ありの話者では「## 相手について」が system に注入される", async () => {
    const llm = new FakeLlmClient(['{"speech":"やあクロ","nextState":"対話"}']);
    const ctx = withPersona(
      createTurnContext({
        turnId: "t-prof",
        state: "対話",
        trigger: { type: "user_message", content: "調子どう？", speakerId: "kuro" },
        dialogue: {
          resolveUserDisplayName: () => "クロ",
          resolveUserProfile: () => ({
            displayName: "クロ",
            note: "開発を手伝う相棒のAI。",
          }),
        },
        recentTurns: [],
        recalledEpisodes: [],
      }),
      "キャラクター設定",
    );
    await generateDialogueSpeech(llm, ctx);
    const sys = llm.calls[0].messages.find((m) => m.role === "system");
    expect(sys?.content).toContain("## 相手について");
    expect(sys?.content).toContain("開発を手伝う相棒のAI");
  });

  it("user_message: note 無しの話者では「## 相手について」を注入しない", async () => {
    const llm = new FakeLlmClient(['{"speech":"はい","nextState":"対話"}']);
    const ctx = withPersona(
      createTurnContext({
        turnId: "t-noprof",
        state: "対話",
        trigger: { type: "user_message", content: "やあ", speakerId: "x" },
        dialogue: {
          resolveUserDisplayName: () => "名無し",
          resolveUserProfile: () => ({ displayName: "名無し" }),
        },
        recentTurns: [],
        recalledEpisodes: [],
      }),
      "キャラクター設定",
    );
    await generateDialogueSpeech(llm, ctx);
    const sys = llm.calls[0].messages.find((m) => m.role === "system");
    expect(sys?.content).not.toContain("## 相手について");
  });

  it("heartbeat: 「## 相手について」は注入されない", async () => {
    const llm = new FakeLlmClient(['{"speech":"","nextState":"静穏"}']);
    await generateDialogueSpeech(llm, makeHeartbeatCtx());
    const sys = llm.calls[0].messages.find((m) => m.role === "system");
    expect(sys?.content).not.toContain("## 相手について");
  });

  it("user_message: prior の独り言は multi-turn に含まれない", async () => {
    const llm = new FakeLlmClient(['{"speech":"返答","nextState":"対話"}']);
    const ctx = withPersona(
      createTurnContext({
        turnId: "t-u2",
        state: "対話",
        trigger: { type: "user_message", content: "どうだった？", speakerId: "u1" },
        dialogue,
        recentTurns: [
          { role: "user", speakerId: "u1", content: "調べておいて" },
          { role: "assistant", channel: "monologue", content: "独り言の内容" },
        ],
        recalledEpisodes: [],
      }),
      "キャラクター設定",
    );
    await generateDialogueSpeech(llm, ctx);
    const msgs = llm.calls[0].messages;
    expect(msgs.every((m) => !m.content.includes("独り言の内容"))).toBe(true);
  });
});

describe("generateDialogueSpeech — 視覚チャンネル(image_feed)", () => {
  it("imageFeed があれば最終 user メッセージに images が乗り、周辺視野の注釈が付く", async () => {
    const llm = new FakeLlmClient(['{"speech":"やあ","nextState":"対話"}']);
    const ctx = withPersona(
      createTurnContext({
        turnId: "t-img",
        state: "対話",
        trigger: { type: "user_message", content: "やっほー", speakerId: "u1" },
        dialogue,
        recentTurns: [],
        recalledEpisodes: [],
        imageFeed: ["BASE64FRAME"],
      }),
      "キャラクター設定",
    );
    await generateDialogueSpeech(llm, ctx);
    const msgs = llm.calls[0].messages;
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("user");
    expect(last.images).toEqual(["BASE64FRAME"]);
    expect(last.content).toContain("周辺視野");
  });

  it("imageFeed が空なら images を付けない（普段は画像なし）", async () => {
    const llm = new FakeLlmClient(['{"speech":"やあ","nextState":"対話"}']);
    await generateDialogueSpeech(llm, makeUserCtx());
    const msgs = llm.calls[0].messages;
    const last = msgs[msgs.length - 1];
    expect(last.images).toBeUndefined();
    expect(last.content).not.toContain("周辺視野");
  });
});

describe("parseLanguageOutput — 生の思考・壊れたJSONを絶対に漏らさない", () => {
  it("<think>…</think> 付きの出力から think を除去して speech だけ返す", async () => {
    const raw =
      '<think>\nThe user asked X. I should respond.\nnextState should be 静穏.\n例: {"speech":"foo"}\n</think>\n\n{"speech":"文書を仕上げた。次に進もう。","nextState":"静穏"}';
    const llm = new FakeLlmClient([raw]);
    const out = await generateDialogueSpeech(llm, makeHeartbeatCtx());
    expect(out.speech).toBe("文書を仕上げた。次に進もう。");
    expect(out.speech).not.toContain("<think>");
    expect(out.speech).not.toContain("{");
  });

  it("speech文字列が閉じずnextStateを巻き込んだ壊れJSONから speech を救出する", async () => {
    // 実際に流出した形: speech の閉じ引用符と , が欠落
    const raw =
      '{\n"speech": "見つからなかったみたい。好きなジャンルは決まってる？\nnextState": "対話"\n}';
    const llm = new FakeLlmClient([raw]);
    const out = await generateDialogueSpeech(llm, makeUserCtx());
    expect(out.speech).toBe("見つからなかったみたい。好きなジャンルは決まってる？");
    expect(out.speech).not.toContain("nextState");
    expect(out.speech).not.toContain("{");
  });

  it("素のテキスト（JSONでない）はそのまま発話として扱う", async () => {
    const llm = new FakeLlmClient(["こんにちは、元気だよ。"]);
    const out = await generateDialogueSpeech(llm, makeUserCtx());
    expect(out.speech).toBe("こんにちは、元気だよ。");
  });

  it("救出不能な壊れJSON断片は沈黙にフォールバック（生を出さない）", async () => {
    const llm = new FakeLlmClient(['{"spee', "ch broken } {"]);
    const out = await generateDialogueSpeech(llm, makeUserCtx());
    expect(out.speech).toBe("");
  });
});
