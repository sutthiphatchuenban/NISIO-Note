import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, parse, sep } from "node:path";
import type { Eol } from "./store.ts";
import { revealInWindows } from "./shell.ts";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DIR_ENTRIES = 2000;
const STAT_LIMIT = 400;

export type Fail = { ok: false; error: string };

export interface Crumb {
  label: string;
  path: string;
}

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  ext: string;
}

export interface DirListing {
  path: string;
  parent: string | null;
  crumbs: Crumb[];
  entries: DirEntry[];
}

export interface TextFile {
  path: string;
  name: string;
  dir: string;
  content: string;
  eol: Eol;
  bom: boolean;
  mtime: number;
  size: number;
}

export interface FileStat {
  path: string;
  exists: boolean;
  mtime: number;
  size: number;
}

export interface Place {
  label: string;
  path: string;
}

export function expandPath(input: string, base?: string | null): string {
  let value = (input || "").trim();
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = join(homedir(), value.slice(2));
  }
  if (!isAbsolute(value)) value = join(base || homedir(), value);
  return normalize(value);
}

function userMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return "File or folder not found.";
    case "EACCES":
    case "EPERM":
      return "Permission denied.";
    case "EBUSY":
      return "The file is in use by another program.";
    case "ENOSPC":
      return "The disk is full.";
    case "ENAMETOOLONG":
      return "That path is too long for Windows.";
    case "EISDIR":
      return "That path is a folder.";
    case "ENOTDIR":
      return "Part of that path is not a folder.";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

function crumbsFor(dir: string): Crumb[] {
  const root = parse(dir).root;
  const rest = dir.slice(root.length);
  const parts = rest.split(sep).filter(Boolean);
  const labels: Crumb[] = [
    { label: root.replace(/[\\/]+$/, "") || sep, path: root },
  ];
  let acc = root;
  for (const part of parts) {
    acc = join(acc, part);
    labels.push({ label: part, path: acc });
  }
  return labels;
}

function compareEntries(a: DirEntry, b: DirEntry) {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

// Bindings must finish synchronously while webview.run() blocks Bun's event loop.
function tryStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export function listDir(input?: string | null): { ok: true; listing: DirListing } | Fail {
  try {
    const dir = expandPath(input || homedir());
    const info = tryStat(dir);
    if (!info) return { ok: false, error: `Folder not found: ${dir}` };
    if (!info.isDirectory()) return { ok: false, error: `Not a folder: ${dir}` };

    const dirents = readdirSync(dir, { withFileTypes: true });
    const visible = dirents
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => entry.name !== "$RECYCLE.BIN" && entry.name !== "System Volume Information")
      .slice(0, MAX_DIR_ENTRIES);

    const entries: DirEntry[] = [];
    for (const dirent of visible) {
      const full = join(dir, dirent.name);
      let isDir = dirent.isDirectory();
      if (dirent.isSymbolicLink()) {
        const target = tryStat(full);
        if (!target) continue;
        isDir = target.isDirectory();
      }
      entries.push({
        name: dirent.name,
        path: full,
        dir: isDir,
        size: 0,
        ext: isDir ? "" : extname(dirent.name).slice(1).toLowerCase(),
      });
    }

    const files = entries.filter((entry) => !entry.dir).slice(0, STAT_LIMIT);
    for (const entry of files) {
      const info = tryStat(entry.path);
      entry.size = info?.size ?? 0;
    }

    entries.sort(compareEntries);
    const parent = dirname(dir);
    return {
      ok: true,
      listing: {
        path: dir,
        parent: parent === dir ? null : parent,
        crumbs: crumbsFor(dir),
        entries,
      },
    };
  } catch (error) {
    return { ok: false, error: userMessage(error) };
  }
}

function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

export function readTextFile(
  input: string,
): { ok: true; file: TextFile } | Fail {
  try {
    const path = expandPath(input);
    const info = tryStat(path);
    if (!info) return { ok: false, error: "File not found." };
    if (!info.isFile()) return { ok: false, error: "That path is not a file." };
    if (info.size > MAX_FILE_BYTES) {
      return { ok: false, error: "That file is larger than 20 MB — too big for this notepad." };
    }

    const bytes = readFileSync(path);
    if (looksBinary(bytes)) {
      return { ok: false, error: "That looks like a binary file, not text." };
    }

    let bom = false;
    let offset = 0;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      bom = true;
      offset = 3;
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset));
    } catch {
      return { ok: false, error: "That file is not valid UTF-8. Convert its encoding before editing." };
    }
    const eol: Eol = text.includes("\r\n") ? "CRLF" : "LF";
    const content = text.replace(/\r\n?/g, "\n");

    return {
      ok: true,
      file: {
        path,
        name: basename(path),
        dir: dirname(path),
        content,
        eol,
        bom,
        mtime: info.mtimeMs,
        size: info.size,
      },
    };
  } catch (error) {
    return { ok: false, error: userMessage(error) };
  }
}

export function writeTextFile(opts: {
  path: string;
  content: string;
  eol?: Eol;
  bom?: boolean;
  expectedMtime?: number;
}): { ok: true; file: TextFile } | Fail {
  const path = expandPath(opts.path);
  const dir = dirname(path);
  const tmp = join(dir, `.nisio-${process.pid}-${Date.now()}.tmp`);

  try {
    const info = tryStat(path);
    if (info?.isDirectory()) return { ok: false, error: "That path is a folder." };
    if (opts.expectedMtime && info && info.mtimeMs !== opts.expectedMtime) {
      return { ok: false, error: "This file changed on disk. Reload it or use Save as to keep your edits." };
    }

    const content = opts.content.replace(/\r\n?/g, "\n");
    let data = content;
    if (opts.eol === "CRLF") data = data.replace(/\n/g, "\r\n");
    if (opts.bom) data = `\uFEFF${data}`;
    if (Buffer.byteLength(data, "utf8") > MAX_FILE_BYTES) {
      return { ok: false, error: "That file would be larger than 20 MB — too big for this notepad." };
    }

    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);

    const after = statSync(path);
    return {
      ok: true,
      file: {
        path,
        name: basename(path),
        dir,
        content,
        eol: opts.eol === "CRLF" ? "CRLF" : "LF",
        bom: !!opts.bom,
        mtime: after.mtimeMs,
        size: after.size,
      },
    };
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Preserve the original write error if cleanup fails.
    }
    return { ok: false, error: userMessage(error) };
  }
}

export function fileInfo(input: string): { ok: true; stat: FileStat } | Fail {
  try {
    const path = expandPath(input);
    const info = tryStat(path);
    return {
      ok: true,
      stat: { path, exists: !!info, mtime: info?.mtimeMs ?? 0, size: info?.size ?? 0 },
    };
  } catch (error) {
    return { ok: false, error: userMessage(error) };
  }
}

export function createFolder(
  parent: string,
  name: string,
): { ok: true; path: string } | Fail {
  const folder = name.trim();
  if (!folder) return { ok: false, error: "Enter a folder name." };
  if (folder === "." || folder === "..") return { ok: false, error: "That folder name is reserved." };
  if (/[\\/:*?"<>|]/.test(folder)) {
    return { ok: false, error: "Folder names cannot contain \\ / : * ? \" < > |" };
  }
  if (/[. ]$/.test(folder)) {
    return { ok: false, error: "Windows does not allow folder names ending in a dot or space." };
  }
  const target = join(expandPath(parent), folder);
  try {
    mkdirSync(target);
    return { ok: true, path: target };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, error: "A file or folder with that name already exists." };
    }
    return { ok: false, error: userMessage(error) };
  }
}

export function places(): Place[] {
  const candidates: Place[] = [
    { label: "Home", path: homedir() },
    { label: "Documents", path: join(homedir(), "Documents") },
    { label: "Desktop", path: join(homedir(), "Desktop") },
    { label: "Downloads", path: join(homedir(), "Downloads") },
  ];
  return candidates.filter((place) => existsSync(place.path));
}

export function revealPath(input: string): { ok: true } | Fail {
  try {
    if (!input || input.includes("\0")) return { ok: false, error: "Enter a valid file or folder path." };
    const path = expandPath(input);
    const info = statSync(path);
    if (process.platform === "win32") {
      revealInWindows(path, info.isDirectory());
    } else if (process.platform === "darwin") {
      Bun.spawn(["open", info?.isDirectory() ? path : dirname(path)], { windowsHide: true });
    } else {
      Bun.spawn(["xdg-open", info?.isDirectory() ? path : dirname(path)], { windowsHide: true });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: userMessage(error) };
  }
}

export function openExternal(url: string): { ok: true } | Fail {
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: "Only http and https links can be opened." };
  }
  try {
    if (process.platform === "win32") {
      Bun.spawn(["explorer.exe", url], { windowsHide: true });
    } else if (process.platform === "darwin") {
      Bun.spawn(["open", url], { windowsHide: true });
    } else {
      Bun.spawn(["xdg-open", url], { windowsHide: true });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: userMessage(error) };
  }
}
