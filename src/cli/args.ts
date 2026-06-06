export type CliArgs = {
  speakerId?: string;
  memory?: "lance" | "memory";
  verbose?: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  const userIdx = argv.indexOf("--user");
  if (userIdx >= 0 && argv[userIdx + 1]) out.speakerId = argv[userIdx + 1];
  if (argv.includes("--memory-only")) out.memory = "memory";
  if (argv.includes("--verbose") || argv.includes("-v")) out.verbose = true;
  return out;
}
