import { resolve } from "node:path";

/** Accept an Explorer-supplied path without mistaking internal options for files. */
export function startupFile(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--data-dir") { i++; continue; }
    if (arg === "--open-file") return args[i + 1] ? resolve(args[i + 1]!) : null;
    if (arg.startsWith("--open-file=")) return arg.length > 12 ? resolve(arg.slice(12)) : null;
    if (arg === "--") return args[i + 1] ? resolve(args[i + 1]!) : null;
    if (arg.startsWith("-")) continue;
    return resolve(arg);
  }
  return null;
}
