// Command-line arguments for the eval scripts: `--name value` options,
// `--flag` switches, and positional arguments, in any order.
export interface Args {
  positional: string[];
  option(name: string): string | undefined;
  flag(name: string): boolean;
}

export function parseArgs(argv: string[], valued: readonly string[]): Args {
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valued.includes(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options.set(arg, value);
    } else if (arg.startsWith("--")) {
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }
  return {
    positional,
    option: (name) => options.get(name),
    flag: (name) => flags.has(name),
  };
}

export function usage(text: string): never {
  console.error(`usage: ${text}`);
  process.exit(1);
}
