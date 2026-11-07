import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const APP_NAME = "NISIO Note";

/** True when running from a `bun build --compile` binary. */
export const isCompiled = Bun.embeddedFiles.length > 0;

function argValue(flag: string): string | null {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === undefined) continue;
    if (value === flag) return argv[i + 1] ?? "";
    if (value.startsWith(`${flag}=`)) return value.slice(flag.length + 1);
  }
  return null;
}

const overrideDir = process.env.NISIO_DATA_DIR || argValue("--data-dir");

/** Per-user storage for settings, recovery data and crash logs. */
export const appDataDir = (() => {
  if (overrideDir) {
    const dir = resolve(overrideDir);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const dir = join(base, APP_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
})();

export function appendCrashLog(kind: string, error: unknown) {
  try {
    const detail =
      error instanceof Error ? error.stack || error.message : String(error);
    appendFileSync(
      join(appDataDir, "crash.log"),
      `[${new Date().toISOString()}] ${kind}: ${detail}\n`,
    );
  } catch {
    // Nothing useful we can do if the log itself cannot be written.
  }
}
