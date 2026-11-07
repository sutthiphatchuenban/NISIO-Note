import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { SizeHint, Webview } from "webview-bun";
import pkg from "../package.json";
import {
  createFolder,
  fileInfo,
  listDir,
  openExternal,
  places,
  readTextFile,
  revealPath,
  writeTextFile,
} from "./files.ts";
import { APP_NAME, appDataDir, appendCrashLog, isCompiled } from "./paths.ts";
import {
  clearRecents,
  clearSession,
  forgetRecent,
  getSettings,
  loadSession,
  loadSettings,
  patchSettings,
  rememberRecent,
  moveRecent,
  setRecentPinned,
  saveSession,
  type Settings,
} from "./store.ts";
import { buildHtml } from "./ui-html.ts";
import { setupWindow } from "./window.ts";
import { installedFonts } from "./fonts.ts";
import { chooseFile } from "./dialogs.ts";
import { searchNotes } from "./search.ts";
import { readClipboard, writeClipboard } from "./clipboard.ts";
import { readClipboardImage, readImage, saveImage } from "./attachments.ts";
import type { Pointer } from "bun:ffi";
import { startupFile } from "./arguments.ts";

const argv = process.argv.slice(2);
const DEBUG = !isCompiled || argv.includes("--debug");
const SMOKE = argv.includes("--smoke");

process.on("uncaughtException", (error) => appendCrashLog("uncaughtException", error));
process.on("unhandledRejection", (error) => appendCrashLog("unhandledRejection", error));

const settings = loadSettings();
const notesDir = join(appDataDir, "Notes");
mkdirSync(notesDir, { recursive: true });

function isManagedNote(path: string) {
  return dirname(path).toLowerCase() === notesDir.toLowerCase()
    && /^note-[0-9a-f-]{36}\.txt$/i.test(basename(path));
}

function noteTitle(content: string) {
  const fallback = getSettings().lang === "th" ? "โน้ตไม่มีชื่อ" : "Untitled";
  return Array.from(content.split(/\r?\n/, 1)[0]?.trim() || fallback).slice(0, 60).join("");
}

function recentName(file: { path: string; name: string; content: string }) {
  return isManagedNote(file.path) ? noteTitle(file.content) : file.name;
}

// Upgrade display names without renaming or modifying existing note files.
for (const recent of settings.recents) {
  if (!isManagedNote(recent.path)) continue;
  const result = readTextFile(recent.path);
  if (result.ok) recent.name = recentName(result.file);
}
patchSettings({ recents: settings.recents });

const view = new Webview(DEBUG, {
  width: Math.round(settings.window.width),
  height: Math.round(settings.window.height),
  hint: SizeHint.NONE,
});
view.title = APP_NAME;
setupWindow(view);

function fail(error: string) {
  return { ok: false as const, error };
}

view.bind("nReady", () => ({
  ok: true as const,
  app: {
    name: APP_NAME,
    version: pkg.version,
    platform: process.platform,
    sep,
    home: homedir(),
    dataDir: appDataDir,
    notesDir,
    bun: Bun.version,
    debug: DEBUG,
    compiled: isCompiled,
    startupFile: startupFile(argv),
  },
  settings: getSettings(),
  session: loadSession(),
  places: places(),
}));

view.bind("nSettings", (payload: { patch?: Partial<Settings> } = {}) => {
  try {
    const next = patchSettings(payload.patch ?? {});
    return { ok: true as const, settings: next };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
});

view.bind("nFileDialog", (payload: { mode: "open" | "save"; startDir?: string | null; name?: string }) => {
  const result = chooseFile({
    owner: (view as Webview & { readonly unsafeWindowHandle: Pointer | null }).unsafeWindowHandle,
    mode: payload.mode,
    directory: payload.startDir || getSettings().lastDir || notesDir,
    name: payload.name || "",
  });
  if (!result.ok || !result.path) return result;
  const dir = dirname(result.path);
  patchSettings({ lastDir: dir });
  return { ...result, dir };
});

view.bind("nClipboardRead", () => readClipboard());
view.bind("nClipboardWrite", (payload: { text: string }) => writeClipboard(payload.text));
view.bind("nImageSave", (payload: { base64?: string } = {}) => saveImage(payload.base64 || ""));
view.bind("nImageRead", (payload: { id?: string } = {}) => readImage(payload.id || ""));
view.bind("nImagePaste", () => readClipboardImage());
view.bind("nFonts", () => installedFonts());
view.bind("nSearchNotes", (payload: { query?: string } = {}) =>
  searchNotes(payload.query || "", notesDir, getSettings().recents),
);

view.bind("nListDir", (payload: { path?: string | null } = {}) => listDir(payload.path));

view.bind("nOpen", (payload: { path: string }) => {
  const result = readTextFile(payload.path);
  if (!result.ok) return result;
  const recents = rememberRecent(result.file.path, recentName(result.file), result.file.dir);
  return { ok: true as const, file: result.file, recents };
});

view.bind(
  "nSave",
  (payload: {
    path: string;
    content?: string;
    eol?: "LF" | "CRLF";
    bom?: boolean;
    expectedMtime?: number;
  }) => {
    const result = writeTextFile({
      path: payload.path || join(notesDir, `note-${randomUUID()}.txt`),
      content: payload.content ?? "",
      eol: payload.eol,
      bom: payload.bom,
      expectedMtime: payload.expectedMtime,
    });
    if (!result.ok) return result;
    const recents = rememberRecent(result.file.path, recentName(result.file), result.file.dir);
    // The renderer already owns the content; avoid serializing it back over IPC.
    const { content, ...file } = result.file;
    return { ok: true as const, file, recents };
  },
);

view.bind("nStat", (payload: { path: string }) => fileInfo(payload.path));

view.bind("nMkdir", (payload: { parent: string; name: string }) =>
  createFolder(payload.parent, payload.name),
);

view.bind("nReveal", (payload: { path: string }) => revealPath(payload.path));

view.bind("nExternal", (payload: { url: string }) => openExternal(payload.url));

view.bind(
  "nRecents",
  (payload: { clear?: boolean; remove?: boolean; pin?: boolean; path?: string; move?: boolean; beforePath?: string | null } = {}) => {
    if (payload.move && typeof payload.path === "string"
      && (payload.beforePath === null || typeof payload.beforePath === "string")) {
      return { ok: true as const, recents: moveRecent(payload.path, payload.beforePath) };
    }
    if (payload.clear) return { ok: true as const, recents: clearRecents() };
    if (payload.remove && payload.path) {
      return { ok: true as const, recents: forgetRecent(payload.path) };
    }
    if (typeof payload.pin === "boolean" && payload.path) {
      return { ok: true as const, recents: setRecentPinned(payload.path, payload.pin) };
    }
    return { ok: true as const, recents: getSettings().recents };
  },
);

view.bind(
  "nSession",
  (payload: {
    path?: string | null;
    dir?: string | null;
    name?: string;
    content?: string;
    dirty?: boolean;
    eol?: "LF" | "CRLF";
    bom?: boolean;
    mtime?: number;
    at?: number;
  } = {}) => {
    saveSession({
      path: payload.path ?? null,
      dir: payload.dir ?? null,
      name: payload.name || "Untitled",
      content: payload.content ?? "",
      dirty: payload.dirty === true,
      eol: payload.eol === "CRLF" ? "CRLF" : "LF",
      bom: payload.bom === true,
      mtime: typeof payload.mtime === "number" ? payload.mtime : 0,
      at: typeof payload.at === "number" ? payload.at : Date.now(),
    });
    return { ok: true as const };
  },
);

view.bind("nSessionClear", () => {
  clearSession();
  return { ok: true as const };
});

view.bind("nTitle", (payload: { text?: string } = {}) => {
  const text = (payload.text || APP_NAME).replace(/[\u0000-\u001f]/g, " ").slice(0, 180);
  view.title = text;
  return { ok: true as const };
});

view.bind("nLog", (payload: { level?: string; message?: string } = {}) => {
  if (!isCompiled) {
    const level = payload.level === "error" ? "error" : "log";
    console[level](`[ui] ${payload.message ?? ""}`);
  }
  return { ok: true as const };
});

view.bind("nQuit", () => {
  process.exit(0);
});

view.bind("nSmoke", (report: unknown) => {
  const text = JSON.stringify(report, null, 2);
  process.stdout.write(`${text}\n`);
  const ok = !!(report && typeof report === "object" && (report as { ok?: boolean }).ok);
  process.exit(ok ? 0 : 1);
});

if (SMOKE) view.init("window.__NISIO_SMOKE__ = true;");
if (SMOKE && argv.includes("--shell-smoke")) view.init("window.__NISIO_SHELL_SMOKE__ = true;");

view.setHTML(buildHtml());
view.run();
process.exit(0);
