import { access } from "node:fs/promises";
import path from "node:path";
import { loadSettings } from "../config/settings.js";
import { lancedbDir } from "../config/paths.js";
import { OllamaEmbedClient } from "../llm/ollama.js";
import { LanceMemoIndexStore } from "../memory/memo-index-lancedb.js";
import { deleteNote, notesDir, safePath } from "../tools/notes.js";
import { regenerateIndexChain } from "../memo/tree.js";
import { INDEX_FILENAME } from "../memo/tree.js";

/**
 * メモ削除ユーティリティ。ノート削除は3点（ファイル / memo_index 行 / MOC `_index.md`）を
 * 必ず揃える必要がある（recall は実在チェックをせず、ファイルだけ消すと索引が死パスを返し続け
 * → 作話の温床になる）。手作業の漏れを無くすためにこのコマンドへ集約する。
 *
 *   npm run notes:rm -- <相対パス> [<相対パス>...]   # 指定ノートを3点セットで削除
 *   npm run notes:rm -- --prune-orphans              # 実体の無い索引行（orphan）を一掃
 *   npm run notes:rm -- --list-orphans               # orphan を一覧（消さない）
 *   オプション: -n / --dry-run（消さずに対象だけ表示）
 */

async function fileExists(rel: string): Promise<boolean> {
  try {
    await access(path.join(notesDir(), rel));
    return true;
  } catch {
    return false;
  }
}

async function openStore(): Promise<LanceMemoIndexStore> {
  const settings = await loadSettings();
  const host = process.env.OLLAMA_HOST ?? settings.ollamaHost;
  const embedder = new OllamaEmbedClient(host, settings.embedModel);
  return LanceMemoIndexStore.open(lancedbDir(), embedder);
}

async function pruneOrphans(dryRun: boolean): Promise<void> {
  const store = await openStore();
  const entries = await store.list();
  const orphans: string[] = [];
  for (const e of entries) {
    if (!(await fileExists(e.path))) orphans.push(e.path);
  }
  if (orphans.length === 0) {
    console.error("orphan なし（索引はすべて実体と対応）");
    return;
  }
  console.error(`orphan（実体の無い索引行）${orphans.length} 件:`);
  for (const o of orphans) console.error(`  ${o}`);
  if (dryRun) {
    console.error("(dry-run: 何も消していない)");
    return;
  }
  for (const o of orphans) await store.delete(o);
  console.error(`${orphans.length} 件の orphan 索引行を削除した`);
}

async function removeNotes(paths: string[], dryRun: boolean): Promise<void> {
  const store = await openStore();
  for (const raw of paths) {
    const rel = safePath(raw);
    if (!rel) {
      console.error(`skip（不正なパス）: ${raw}`);
      continue;
    }
    if (rel.endsWith(INDEX_FILENAME)) {
      console.error(`skip（_index.md は機械生成の派生ビュー・直接消さない）: ${rel}`);
      continue;
    }
    const exists = await fileExists(rel);
    if (dryRun) {
      console.error(
        `[dry-run] ${rel} を削除（ファイル${exists ? "" : "=既に無し"} / 索引 / MOC 再生成）`,
      );
      continue;
    }
    await deleteNote(rel); // ファイル
    await store.delete(rel); // memo_index 行
    await regenerateIndexChain(rel); // 親 _index.md チェーンを再生成
    console.error(`削除: ${rel}（ファイル${exists ? "" : "=既に無し"}・索引・MOC）`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || args.includes("-n");
  const rest = args.filter((a) => a !== "--dry-run" && a !== "-n");

  if (rest.includes("--list-orphans")) {
    await pruneOrphans(true);
    return;
  }
  if (rest.includes("--prune-orphans")) {
    await pruneOrphans(dryRun);
    return;
  }
  const targets = rest.filter((a) => !a.startsWith("-"));
  if (targets.length === 0) {
    console.error(
      [
        "使い方:",
        "  npm run notes:rm -- <相対パス> [...]   ノートを3点セット（ファイル/索引/MOC）で削除",
        "  npm run notes:rm -- --prune-orphans     実体の無い索引行を一掃",
        "  npm run notes:rm -- --list-orphans      orphan を一覧（消さない）",
        "  -n / --dry-run                          消さずに対象だけ表示",
      ].join("\n"),
    );
    process.exit(1);
  }
  await removeNotes(targets, dryRun);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
