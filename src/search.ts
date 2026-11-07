import { readdirSync, statSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { expandPath, readTextFile, type Fail } from "./files.ts";
import type { RecentEntry } from "./store.ts";

const MAX_CANDIDATES = 500;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_RESULTS = 50;
const MAX_SNIPPET_LENGTH = 140;

export interface SearchResult {
  path: string;
  name: string;
  dir: string;
  id: string;
  snippet: string;
}

function snippet(content: string, match: number): string {
  const start = Math.max(0, match - 40);
  return content.slice(start, start + MAX_SNIPPET_LENGTH).replace(/\s+/g, " ").trim();
}

export function searchNotes(
  query: string,
  notesDir: string,
  recents: RecentEntry[],
): { ok: true; results: SearchResult[]; truncated: boolean } | Fail {
  const needle = query.trim().toLowerCase();
  if (!needle) return { ok: false, error: "Enter a search query." };

  const directory = expandPath(notesDir);
  let entries;
  try {
    // Dirent names, not user-provided paths; do not recurse or follow directory links.
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "Folder not found"
      : code === "ENOTDIR" ? "Not a folder"
      : code === "EACCES" || code === "EPERM" ? "Permission denied"
      : "Unable to read notes folder";
    return { ok: false, error: `${reason}: ${directory}` };
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  let truncated = entries.length > MAX_CANDIDATES || recents.length > MAX_CANDIDATES;
  function addCandidate(path: string) {
    const normalized = expandPath(path);
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    if (candidates.length >= MAX_CANDIDATES) {
      truncated = true;
      return;
    }
    seen.add(key);
    candidates.push(normalized);
  }

  // Bound enumeration work as well as file reads, even in unrelated large folders.
  for (const entry of entries.slice(0, MAX_CANDIDATES)) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".txt") {
      addCandidate(expandPath(entry.name, directory));
    }
  }
  for (const recent of recents.slice(0, MAX_CANDIDATES)) {
    addCandidate(recent.path);
  }

  const results: SearchResult[] = [];
  let scannedBytes = 0;
  for (const path of candidates) {
    let size: number;
    try {
      const info = statSync(path);
      if (!info.isFile()) continue;
      size = info.size;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") truncated = true;
      continue;
    }
    if (size > MAX_FILE_BYTES || size > MAX_SCAN_BYTES - scannedBytes) {
      truncated = true;
      continue;
    }
    // Charge attempted reads too: binary or unreadable files must not evade the budget.
    scannedBytes += size;
    const result = readTextFile(path);
    if (!result.ok) {
      if (result.error !== "File not found.") truncated = true;
      continue;
    }

    const file = result.file;
    const id = basename(file.path, extname(file.path));
    const managed = dirname(file.path).toLowerCase() === directory.toLowerCase()
      && /^note-[0-9a-f-]{36}\.txt$/i.test(file.name);
    const name = managed
      ? Array.from(file.content.split(/\r?\n/, 1)[0]?.trim() || "โน้ตไม่มีชื่อ").slice(0, 60).join("")
      : file.name;
    const contentMatch = file.content.toLowerCase().indexOf(needle);
    if (contentMatch < 0 && ![name, id, file.path].some((value) => value.toLowerCase().includes(needle))) {
      continue;
    }
    results.push({
      path: file.path,
      name,
      dir: file.dir,
      id,
      snippet: snippet(file.content, Math.max(0, contentMatch)),
    });
    if (results.length >= MAX_RESULTS) {
      truncated = true;
      break;
    }
  }
  return { ok: true, results, truncated };
}
