import type { LogLevel } from "../util/verbose.js";

export type CliArgs = {
  speakerId?: string;
  memory?: "lance" | "memory";
  /** 未指定時はエントリポイント側が既定を決める（REPL=quiet, 常駐=info） */
  logLevel?: LogLevel;
};

export type DreamCliArgs = CliArgs & {
  /** --seed 指定時。空文字は既定パス data/semantic-seed.json */
  seedPath?: string;
  forceSeed?: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  const userIdx = argv.indexOf("--user");
  if (userIdx >= 0 && argv[userIdx + 1]) out.speakerId = argv[userIdx + 1];
  if (argv.includes("--memory-only")) out.memory = "memory";
  if (argv.includes("--verbose") || argv.includes("-v")) out.logLevel = "debug";
  else if (argv.includes("--quiet") || argv.includes("-q")) out.logLevel = "quiet";
  return out;
}

export function parseDreamArgs(argv: string[]): DreamCliArgs {
  const out: DreamCliArgs = { ...parseArgs(argv) };
  const seedIdx = argv.indexOf("--seed");
  if (seedIdx >= 0) {
    const next = argv[seedIdx + 1];
    out.seedPath =
      next && !next.startsWith("-") ? next : "";
  }
  if (argv.includes("--force-seed")) out.forceSeed = true;
  return out;
}
