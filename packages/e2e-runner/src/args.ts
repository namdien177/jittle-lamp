// Shared argument parsing has no CLI entrypoint side effects.
export type ParsedArgs = { command: string; positionals: string[]; flags: Map<string, string[]> };

const booleanFlags = new Set(["fail-on-blocked", "once", "code", "headed", "upload", "wait", "help", "json", "with-secrets", "allow-claude-code", "force"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    const value = inline ?? (booleanFlags.has(name) ? "true" : rest[++index]);
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, positionals, flags };
}

