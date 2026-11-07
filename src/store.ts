import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDataDir } from "./paths.ts";

export type Theme = "auto" | "light" | "dark";
export type Eol = "LF" | "CRLF";
export type Lang = "en" | "th";

export interface RecentEntry {
  path: string;
  name: string;
  dir: string;
  at: number;
  pinned?: boolean;
}

export interface Settings {
  lang: Lang;
  theme: Theme;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  fontWeight: number;
  wrap: boolean;
  sidebar: boolean;
  sidebarWidth: number;
  lineNumbers: boolean;
  autosave: boolean;
  autosaveDelay: number;
  spellcheck: boolean;
  autoIndent: boolean;
  defaultEol: Eol;
  preview: boolean;
  previewWidth: number;
  softTabs: boolean;
  tabSize: number;
  reopenLast: boolean;
  window: { width: number; height: number };
  lastDir: string | null;
  recents: RecentEntry[];
}

export interface SessionState {
  path: string | null;
  dir: string | null;
  name: string;
  content: string;
  dirty: boolean;
  eol: Eol;
  bom: boolean;
  mtime: number;
  at: number;
}

export const DEFAULT_SETTINGS: Settings = {
  lang: "en",
  theme: "auto",
  fontSize: 15,
  fontFamily: "",
  lineHeight: 1.62,
  fontWeight: 400,
  wrap: false,
  sidebar: true,
  sidebarWidth: 218,
  lineNumbers: true,
  autosave: true,
  autosaveDelay: 1600,
  spellcheck: false,
  autoIndent: true,
  defaultEol: "LF",
  preview: false,
  previewWidth: 50,
  softTabs: true,
  tabSize: 2,
  reopenLast: true,
  window: { width: 1120, height: 740 },
  lastDir: null,
  recents: [],
};

const settingsPath = join(appDataDir, "settings.json");
const sessionPath = join(appDataDir, "session.json");

let tmpSeq = 0;

// Complete persistence before returning to the blocking native webview loop.
function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Preserve the original write error if cleanup fails.
    }
    throw error;
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function asBool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function isRecent(value: unknown): value is RecentEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    entry.path.length > 0 &&
    typeof entry.name === "string" &&
    typeof entry.dir === "string" &&
    typeof entry.at === "number"
  );
}

const MAX_RECENTS = 12;

function trimRecents(entries: RecentEntry[]): RecentEntry[] {
  if (entries.length <= MAX_RECENTS) return entries;
  const pinnedCount = entries.filter((entry) => entry.pinned === true).length;
  const room = Math.max(0, MAX_RECENTS - pinnedCount);
  let unpinnedKept = 0;
  return entries.filter((entry) => {
    if (entry.pinned === true) return true;
    unpinnedKept++;
    return unpinnedKept <= room;
  });
}

export function sanitizeSettings(raw: unknown): Settings {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const theme =
    input.theme === "light" || input.theme === "dark" || input.theme === "auto"
      ? input.theme
      : DEFAULT_SETTINGS.theme;
  const recents = Array.isArray(input.recents)
    ? trimRecents(
        input.recents
          .filter(isRecent)
          .map((entry) => ({
            path: entry.path,
            name: entry.name,
            dir: entry.dir,
            at: entry.at,
            ...(entry.pinned === true ? { pinned: true } : {}),
          })),
      )
    : [];
  const lastDir = typeof input.lastDir === "string" && input.lastDir.length > 0 ? input.lastDir : null;
  const win = (input.window && typeof input.window === "object" ? input.window : {}) as Record<
    string,
    unknown
  >;

  return {
    lang: input.lang === "th" ? "th" : "en",
    theme,
    fontSize: clampNumber(input.fontSize, 10, 32, DEFAULT_SETTINGS.fontSize),
    fontFamily: typeof input.fontFamily === "string" ? input.fontFamily : DEFAULT_SETTINGS.fontFamily,
    lineHeight: clampNumber(input.lineHeight, 1.1, 2.5, DEFAULT_SETTINGS.lineHeight),
    fontWeight: Math.round(clampNumber(input.fontWeight, 100, 900, DEFAULT_SETTINGS.fontWeight)),
    wrap: asBool(input.wrap, DEFAULT_SETTINGS.wrap),
    sidebar: asBool(input.sidebar, DEFAULT_SETTINGS.sidebar),
    sidebarWidth: Math.round(
      clampNumber(input.sidebarWidth, 160, 520, DEFAULT_SETTINGS.sidebarWidth),
    ),
    lineNumbers: asBool(input.lineNumbers, DEFAULT_SETTINGS.lineNumbers),
    autosave: asBool(input.autosave, DEFAULT_SETTINGS.autosave),
    autosaveDelay: Math.round(clampNumber(input.autosaveDelay, 500, 10000, DEFAULT_SETTINGS.autosaveDelay)),
    spellcheck: asBool(input.spellcheck, DEFAULT_SETTINGS.spellcheck),
    autoIndent: asBool(input.autoIndent, DEFAULT_SETTINGS.autoIndent),
    defaultEol: input.defaultEol === "LF" || input.defaultEol === "CRLF"
      ? input.defaultEol
      : DEFAULT_SETTINGS.defaultEol,
    preview: asBool(input.preview, DEFAULT_SETTINGS.preview),
    previewWidth: Math.round(
      clampNumber(input.previewWidth, 20, 80, DEFAULT_SETTINGS.previewWidth),
    ),
    softTabs: asBool(input.softTabs, DEFAULT_SETTINGS.softTabs),
    tabSize: Math.round(clampNumber(input.tabSize, 1, 8, DEFAULT_SETTINGS.tabSize)),
    reopenLast: asBool(input.reopenLast, DEFAULT_SETTINGS.reopenLast),
    window: {
      width: Math.round(clampNumber(win.width, 720, 4000, DEFAULT_SETTINGS.window.width)),
      height: Math.round(clampNumber(win.height, 480, 3000, DEFAULT_SETTINGS.window.height)),
    },
    lastDir,
    recents,
  };
}

let current: Settings = DEFAULT_SETTINGS;

export function loadSettings(): Settings {
  try {
    const text = readFileSync(settingsPath, "utf8");
    current = sanitizeSettings(JSON.parse(text));
  } catch {
    current = sanitizeSettings(DEFAULT_SETTINGS);
  }
  return current;
}

export function getSettings(): Settings {
  return current;
}

export function patchSettings(patch: Partial<Settings>): Settings {
  current = sanitizeSettings({ ...current, ...patch });
  const snapshot = JSON.stringify(current, null, 2);
  try {
    writeAtomic(settingsPath, snapshot);
  } catch (error) {
    console.error("Failed to write settings:", error);
  }
  return current;
}

export function rememberRecent(path: string, name: string, dir: string): RecentEntry[] {
  const existing = current.recents.find((item) => item.path.toLowerCase() === path.toLowerCase());
  const entry: RecentEntry = {
    path,
    name,
    dir,
    at: Date.now(),
    ...(existing?.pinned === true ? { pinned: true } : {}),
  };
  const recents = existing
    ? current.recents.map((item) => item.path.toLowerCase() === path.toLowerCase() ? entry : item)
    : trimRecents([entry, ...current.recents]);
  return patchSettings({ recents }).recents;
}

export function setRecentPinned(path: string, pinned: boolean): RecentEntry[] {
  const key = path.toLowerCase();
  const recents = current.recents.map((item) =>
    item.path.toLowerCase() === key
      ? pinned
        ? { ...item, pinned: true }
        : { path: item.path, name: item.name, dir: item.dir, at: item.at }
      : item,
  );
  return patchSettings({ recents }).recents;
}

export function moveRecent(path: string, beforePath: string | null): RecentEntry[] {
  const key = path.toLowerCase();
  const entry = current.recents.find((item) => item.path.toLowerCase() === key);
  if (!entry || beforePath?.toLowerCase() === key) return current.recents;
  const recents = current.recents.filter((item) => item.path.toLowerCase() !== key);
  const index = beforePath === null ? recents.length
    : recents.findIndex((item) => item.path.toLowerCase() === beforePath.toLowerCase());
  if (index < 0) return current.recents;
  recents.splice(index, 0, entry);
  return patchSettings({ recents }).recents;
}

export function forgetRecent(path: string): RecentEntry[] {
  const recents = current.recents.filter(
    (item) => item.path.toLowerCase() !== path.toLowerCase(),
  );
  return patchSettings({ recents }).recents;
}

export function clearRecents(): RecentEntry[] {
  return patchSettings({ recents: [] }).recents;
}

export function loadSession(): SessionState | null {
  try {
    const raw = JSON.parse(readFileSync(sessionPath, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.content !== "string") return null;
    return {
      path: typeof raw.path === "string" && raw.path.length > 0 ? raw.path : null,
      dir: typeof raw.dir === "string" && raw.dir.length > 0 ? raw.dir : null,
      name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : "Untitled",
      content: raw.content,
      dirty: raw.dirty === true,
      eol: raw.eol === "CRLF" ? "CRLF" : "LF",
      bom: raw.bom === true,
      mtime: typeof raw.mtime === "number" && Number.isFinite(raw.mtime) ? raw.mtime : 0,
      at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : Date.now(),
    };
  } catch {
    return null;
  }
}

const MAX_SESSION_CHARS = 1_500_000;

export function saveSession(state: SessionState): void {
  if (state.content.length > MAX_SESSION_CHARS) {
    clearSession();
    return;
  }
  try {
    writeAtomic(sessionPath, JSON.stringify(state));
  } catch (error) {
    console.error("Failed to write session:", error);
  }
}

export function clearSession(): void {
  try {
    unlinkSync(sessionPath);
  } catch {
    // Already gone.
  }
}
