import { describe, it, expect } from "vitest";
import { applyMemoOp } from "../src/memo/ops.js";

describe("applyMemoOp", () => {
  describe("create", () => {
    it("新規本文を作る", () => {
      const r = applyMemoOp(null, { op: "create", content: "やること\n- 牛乳" });
      expect(r).toMatchObject({ ok: true, opKind: "create" });
      if (r.ok) expect(r.nextContent).toBe("やること\n- 牛乳\n");
    });

    it("既存があるとき create は失敗（盲目上書き禁止）", () => {
      const r = applyMemoOp("既存", { op: "create", content: "新規" });
      expect(r.ok).toBe(false);
    });

    it("空本文は失敗", () => {
      expect(applyMemoOp(null, { op: "create", content: "  " }).ok).toBe(false);
    });
  });

  describe("append", () => {
    it("末尾に追記する（既存は保全）", () => {
      const r = applyMemoOp("一行目", { op: "append", content: "二行目" });
      expect(r).toMatchObject({ ok: true, opKind: "append" });
      if (r.ok) expect(r.nextContent).toBe("一行目\n\n二行目\n");
    });

    it("対象が無いときは create に倒す（情報を失わない）", () => {
      const r = applyMemoOp(null, { op: "append", content: "初回" });
      expect(r).toMatchObject({ ok: true, opKind: "create" });
    });
  });

  describe("replace（read-before-edit / 厳密一致）", () => {
    it("一意に一致する箇所を置換する", () => {
      const r = applyMemoOp("空は青い。海も青い。", {
        op: "replace",
        old: "空は青い",
        content: "空は灰色だ",
      });
      expect(r).toMatchObject({ ok: true, opKind: "replace" });
      if (r.ok) expect(r.nextContent).toBe("空は灰色だ。海も青い。");
    });

    it("old が一致しなければ失敗（盲目改変しない）", () => {
      const r = applyMemoOp("本文", { op: "replace", old: "存在しない", content: "x" });
      expect(r.ok).toBe(false);
    });

    it("old が複数箇所に一致すると曖昧で失敗", () => {
      const r = applyMemoOp("青 青", { op: "replace", old: "青", content: "赤" });
      expect(r.ok).toBe(false);
    });

    it("対象本文が無ければ失敗", () => {
      expect(applyMemoOp(null, { op: "replace", old: "x", content: "y" }).ok).toBe(false);
    });
  });

  describe("section_replace（見出し単位）", () => {
    const doc = ["# 歌", "", "## Aメロ", "古いAメロ", "", "## サビ", "古いサビ", "本文2"].join("\n");

    it("指定見出しの本文だけ差し替え、見出しは保つ", () => {
      const r = applyMemoOp(doc, {
        op: "section_replace",
        heading: "## サビ",
        content: "新しいサビ",
      });
      expect(r).toMatchObject({ ok: true, opKind: "section_replace" });
      if (r.ok) {
        expect(r.nextContent).toContain("## サビ\n新しいサビ");
        expect(r.nextContent).toContain("## Aメロ\n古いAメロ"); // 他セクションは不変
        expect(r.nextContent).not.toContain("古いサビ");
      }
    });

    it("次の同レベル見出しで境界を切る（後続を巻き込まない）", () => {
      const r = applyMemoOp(doc, {
        op: "section_replace",
        heading: "## Aメロ",
        content: "差し替え",
      });
      if (r.ok) {
        expect(r.nextContent).toContain("## サビ\n古いサビ"); // サビは残る
        expect(r.nextContent).not.toContain("古いAメロ");
      }
    });

    it("見出しが無ければ失敗", () => {
      const r = applyMemoOp(doc, { op: "section_replace", heading: "## 無い", content: "x" });
      expect(r.ok).toBe(false);
    });
  });

  describe("view / noop", () => {
    it("view は書き込みなし", () => {
      const r = applyMemoOp("本文", { op: "view" });
      expect(r).toMatchObject({ ok: true, opKind: "view", nextContent: null });
    });
    it("noop は書き込みなし", () => {
      const r = applyMemoOp("本文", { op: "noop" });
      expect(r).toMatchObject({ ok: true, opKind: "noop", nextContent: null });
    });
  });
});
