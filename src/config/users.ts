import { readFile } from "node:fs/promises";
import path from "node:path";

export type UserEntry = {
  id: string;
  display_name: string;
  /** 話者との関係性の一文。言語野の「## 相手について」に注入する */
  note?: string;
};

export type UserProfile = {
  displayName: string;
  note?: string;
};

export async function loadUsers(): Promise<UserEntry[]> {
  const file = path.join(process.cwd(), "config", "users.yaml");
  const raw = await readFile(file, "utf8");
  const users: UserEntry[] = [];
  let current: Partial<UserEntry> = {};

  const flush = () => {
    if (current.id && current.display_name) users.push(current as UserEntry);
  };

  for (const line of raw.split("\n")) {
    const id = line.match(/^\s+-\s+id:\s*(.+)\s*$/);
    if (id) {
      flush();
      current = { id: id[1].trim() };
      continue;
    }
    const name = line.match(/^\s+display_name:\s*(.+)\s*$/);
    if (name && current.id) {
      current.display_name = name[1].trim();
      continue;
    }
    const note = line.match(/^\s+note:\s*(.+)\s*$/);
    if (note && current.id) {
      current.note = note[1].trim();
    }
  }
  flush();
  return users;
}

export function createUserResolver(users: UserEntry[]): (id: string) => string {
  const map = new Map(users.map((u) => [u.id, u.display_name]));
  return (id: string) => map.get(id) ?? id;
}

/** id → 表示名＋関係性プロフィール。未知 id は id をそのまま表示名に。 */
export function createUserProfileResolver(
  users: UserEntry[],
): (id: string) => UserProfile {
  const map = new Map(users.map((u) => [u.id, u]));
  return (id: string) => {
    const entry = map.get(id);
    if (!entry) return { displayName: id };
    return { displayName: entry.display_name, note: entry.note };
  };
}
