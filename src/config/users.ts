import { readFile } from "node:fs/promises";
import path from "node:path";

export type UserEntry = {
  id: string;
  display_name: string;
};

export async function loadUsers(): Promise<UserEntry[]> {
  const file = path.join(process.cwd(), "config", "users.yaml");
  const raw = await readFile(file, "utf8");
  const users: UserEntry[] = [];
  let current: Partial<UserEntry> = {};

  for (const line of raw.split("\n")) {
    const id = line.match(/^\s+-\s+id:\s*(.+)\s*$/);
    if (id) {
      if (current.id) users.push(current as UserEntry);
      current = { id: id[1].trim() };
      continue;
    }
    const name = line.match(/^\s+display_name:\s*(.+)\s*$/);
    if (name && current.id) {
      current.display_name = name[1].trim();
    }
  }
  if (current.id && current.display_name) {
    users.push(current as UserEntry);
  }
  return users;
}

export function createUserResolver(users: UserEntry[]): (id: string) => string {
  const map = new Map(users.map((u) => [u.id, u.display_name]));
  return (id: string) => map.get(id) ?? id;
}
