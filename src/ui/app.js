/*
 * NISIO Note renderer.
 *
 * Vanilla UI with a virtualized CodeMirror editor, bundled into the document.
 * Everything that touches the filesystem goes through the bindings that
 * `src/main.ts` registers (nReady, nOpen, nSave, ...).
 */
import { createEditor } from "./editor.js";

(() => {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* utils                                                              */
  /* ------------------------------------------------------------------ */

  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  const ICONS = {
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>',
    themeAuto: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 2.5v11" stroke="currentColor" stroke-width="1.4"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg>',
    themeDark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 13.6A6 6 0 0 1 7.4 2.4a6 6 0 1 0 3.4 11.2z" fill="currentColor"/></svg>',
    themeLight: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/><g stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13"/></g></svg>',
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function textOf(error) {
    if (!error) return t("somethingWrong");
    if (typeof error === "string") return error;
    if (error.message) return error.message;
    if (error.error) return error.error;
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json;
    } catch {
      /* ignore */
    }
    return t("somethingWrong");
  }

  /** Call a binding registered by the Bun main process. Never throws. */
  function call(name, payload) {
    const fn = window[name];
    if (typeof fn !== "function") {
      return Promise.resolve({ ok: false, error: `Missing binding: ${name}` });
    }
    try {
      return Promise.resolve(fn(payload === undefined ? {} : payload)).catch((error) => ({
        ok: false,
        error: textOf(error),
      }));
    } catch (error) {
      return Promise.resolve({ ok: false, error: textOf(error) });
    }
  }

  function basenameOf(path) {
    if (!path) return t("untitled");
    const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return index >= 0 ? path.slice(index + 1) : path;
  }

  function joinPath(dir, name) {
    if (!dir) return name;
    const sep = S.sep || "\\";
    if (dir.endsWith("/") || dir.endsWith("\\")) return dir + name;
    return dir + sep + name;
  }

  function isAbsoluteish(path) {
    return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
  }

  function shortDir(path) {
    if (!path) return "";
    const home = S.app && S.app.home;
    if (home && path.toLowerCase().startsWith(home.toLowerCase())) {
      return `~${path.slice(home.length)}`;
    }
    return path;
  }

  function fmtNum(value) {
    try {
      return Number(value).toLocaleString();
    } catch {
      return String(value);
    }
  }

  function fmtSize(bytes) {
    if (!bytes || bytes < 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    const rounded = unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1);
    return `${rounded} ${units[unit]}`;
  }

  function fmtClock(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function timeAgo(timestamp) {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 50) return t("justNow");
    if (seconds < 90) return t("minuteAgo");
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t("minutesAgo", { n: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours === 1 ? t("hourAgo") : t("hoursAgo", { n: hours });
    const days = Math.round(hours / 24);
    return days === 1 ? t("dayAgo") : t("daysAgo", { n: days });
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (character) => {
      switch (character) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }

  function fuzzyMatch(needle, haystack) {
    if (!needle) return true;
    let index = 0;
    for (const character of haystack) {
      if (character === needle[index]) index++;
      if (index === needle.length) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* state                                                              */
  /* ------------------------------------------------------------------ */

  function defaultSettings() {
    return {
      lang: "en",
      theme: "auto",
      fontSize: 15,
      fontFamily: "",
      lineHeight: 1.62,
      fontWeight: 400,
      spellcheck: false,
      autoIndent: true,
      defaultEol: "LF",
      autosaveDelay: 1600,
      wrap: false,
      sidebar: true,
      sidebarWidth: 218,
      lineNumbers: true,
      autosave: true,
      preview: false,
      previewWidth: 50,
      softTabs: true,
      tabSize: 2,
      reopenLast: true,
      window: { width: 1120, height: 740 },
      lastDir: null,
      recents: [],
    };
  }

  const S = {
    app: null,
    places: [],
    sep: "\\",
    settings: defaultSettings(),
    recents: [],
    path: null,
    dir: null,
    name: "Untitled",
    dirty: false,
    eol: "LF",
    bom: false,
    mtime: 0,
    savedAt: 0,
    stateLabel: "",
    lineCount: 1,
    gutterCount: -1,
    gutterDigits: -1,
    overlay: null,
    menu: null,
    zen: false,
    maximized: false,
    drawerMode: false,
    find: { matches: [], index: -1 },
    imageCache: new Map(),
    welcome: true,
  };

  const STRINGS = {
    en: {
      somethingWrong: "Something went wrong.",
      untitled: "Untitled",
      cancel: "Cancel",
      ok: "OK",
      close: "Close",
      save: "Save",
      open: "Open",
      reload: "Reload",
      discard: "Discard",
      clear: "Clear",
      create: "Create",
      overwrite: "Overwrite?",
      reset: "Reset",
      remove: "Remove",

      justNow: "just now",
      minuteAgo: "a minute ago",
      minutesAgo: "{n} minutes ago",
      hourAgo: "1 hour ago",
      hoursAgo: "{n} hours ago",
      dayAgo: "1 day ago",
      daysAgo: "{n} days ago",

      chars: "{n} chars",
      words: "{n} words",
      manyWords: "many words",
      lineCol: "Ln {line}, Col {col}",
      selected: "{n} selected",
      unsaved: "Unsaved",
      saved: "Saved",
      autosaved: "Autosaved",
      notSavedYet: "Not saved yet",

      themeTitle: "Theme: {theme} (Ctrl+Shift+D)",
      themeAuto: "System",
      themeLight: "Light",
      themeDark: "Dark",
      themeToast: "Theme: {theme}",
      cycleTheme: "Cycle theme",

      winMinimize: "Minimize",
      winMaximize: "Maximize",
      winRestore: "Restore",
      winClose: "Close",

      toggleSidebarTitle: "Toggle note list (Ctrl+B)",
      toggleSidebarLabel: "Toggle note list",
      allCommandsTitle: "All commands (Ctrl+Shift+P)",
      allCommandsLabel: "All commands",
      menuFile: "File",
      menuEdit: "Edit",
      menuView: "View",
      menuHelp: "Help",
      mainMenu: "Main menu",
      openTitle: "Open a file (Ctrl+O)",
      saveTitle: "Save (Ctrl+S)",
      cycleThemeTitle: "Cycle theme (Ctrl+Shift+D)",
      settingsTitle: "Settings (Ctrl+,)",
      settingsLabel: "Settings",

      recentFilesLabel: "Recent files",
      recentLabel: "RECENT",
      clearRecentsTitle: "Clear recent files",
      searchNotesPlaceholder: "Search notes…",
      searchNotesAria: "Search by title, ID, or note text",
      newNote: "New note",
      browseFiles: "Browse files…",
      resizeSidebarLabel: "Resize sidebar",
      resizeSidebarTitle: "Drag to resize the sidebar · double-click to reset",

      dismiss: "Dismiss",

      findPlaceholder: "Find",
      matchCase: "Match case",
      regex: "Regular expression",
      prevMatch: "Previous match (Shift+F3)",
      nextMatch: "Next match (F3)",
      closeEsc: "Close (Esc)",
      replaceWith: "Replace with",
      replace: "Replace",
      replaceAll: "Replace all",

      noteContent: "Note content",
      resizePreviewLabel: "Resize markdown preview",
      resizePreviewTitle: "Drag to resize the preview · double-click to reset",
      markdownPreview: "Markdown preview",

      revealInExplorer: "Reveal in Explorer",
      toggleLineEndings: "Toggle line endings",
      encoding: "Encoding",

      noRecentFiles: "No recent files yet. Open one with Ctrl+O.",
      noMatchingNotes: "No notes match your search.",
      searching: "Searching…",
      searchResults: "{n} results",
      searchTruncated: " · showing some (search limit reached)",
      removedFromRecents: "Removed from recent files",
      clearRecentsMessage: "Remove every entry from the recent files list? Your files are not deleted.",
      recentsCleared: "Recent files cleared",
      pinNote: "Pin note",
      unpinNote: "Unpin note",
      pinAdded: "Note pinned",
      pinRemoved: "Note unpinned",
      pinnedNote: "Pinned",
      openFile: "Open file",
      showInExplorer: "Show in Explorer",
      removeFromRecents: "Remove from recent files",

      unsavedTitle: "Unsaved changes",
      unsavedMessage: "“{name}” has unsaved changes. Save before {action}?",
      actionOpening: "opening “{name}”",
      actionNewNote: "starting a new note",
      actionQuitting: "quitting",
      actionDropped: "opening a dropped file",

      savedToast: "Saved {name}",
      fileChangedReloaded: "File changed on disk — reloaded",
      fileChangedBanner: "This file changed on disk while you have unsaved edits.",
      keepMine: "Keep mine",
      openCopyBanner: "Opened a copy of “{name}”. Use Save as (Ctrl+Shift+S) to choose where it lives.",

      filterFolder: "Filter this folder…",
      newFolder: "+ Folder",
      newFolderName: "New folder name",
      fileName: "File name",
      openDialogTitle: "Open file",
      saveAsTitle: "Save as",
      loading: "Loading…",
      nothingMatchesFilter: "Nothing matches that filter.",
      folderEmpty: "This folder is empty.",
      parentFolder: "Parent folder",
      selectFileFirst: "Select a file first.",
      enterFileName: "Enter a file name.",
      invalidFileName: 'A file name cannot contain \\ / : * ? " < > |',
      createdFolder: "Created folder {name}",

      palettePlaceholder: "Search commands and recent files…",
      paletteMove: "↑↓ move",
      paletteRun: "↵ run",
      paletteClose: "esc close",
      noMatches: "No matches.",

      invalidPattern: "That search pattern is not valid.",
      noMatchesReplace: "No matches to replace.",
      replacedOne: "Replaced 1 occurrence",
      replacedMany: "Replaced {n} occurrences",
      goToLine: "Go to line",
      lineNumber: "Line number",
      enterNumber: "Enter a number.",
      notSavedYetToast: "This note has not been saved yet.",

      notImage: "That file is not an image.",
      imageTooLarge: "Image is larger than 25 MB.",
      imageConvertFail: "Could not convert the image.",
      imageInserted: "Image inserted · stored on this device",
      imagePasted: "Image pasted from clipboard",
      noClipboardImage: "No image on the clipboard.",

      nothingToPreview: "Nothing to preview yet.",
      missingImage: "Missing image ({id})",
      autosaveOn: "Autosave on",
      autosaveOff: "Autosave off",
      lineEndings: "Line endings: {eol}",
      utf8Info: "NISIO Note reads and writes UTF-8.",
      dropTooLarge: "That file is larger than 20 MB.",
      dropBinary: "Binary files cannot be edited here.",
      dropLooksBinary: "That looks like a binary file.",
      dropChooseOriginal: "Select the original file to open and save it in place.",

      fontSettings: "Font settings",
      installedFonts: "Installed fonts",
      closeFontSettings: "Close font settings",
      fontFamily: "Font family",
      fontPlaceholder: "Consolas (Notepad default)",
      size: "Size",
      weight: "Weight",
      lineSpacing: "Line spacing",
      weightThin: "Thin",
      weightExtraLight: "Extra light",
      weightLight: "Light",
      weightRegular: "Regular",
      weightMedium: "Medium",
      weightSemibold: "Semibold",
      weightBold: "Bold",
      weightExtraBold: "Extra bold",
      weightBlack: "Black",
      readingFonts: "Reading installed fonts…",
      enterFontManually: "Enter a family name manually",
      fontsFound: "{n} installed fonts · type to search",

      settingsSearchPlaceholder: "Search settings…",
      closeSettings: "Close settings",
      settingsCategories: "Settings categories",
      changesApply: "Changes apply immediately · saved automatically",
      resetPreferences: "Reset preferences",
      confirmReset: "Confirm reset (notes kept)",
      savingSettings: "Saving…",
      settingsSaveFailed: "Could not save preferences",
      settingsSaved: "Saved · saved automatically",
      noMatchingSettings: "No matching settings",
      localStorage: "Local storage",
      localStorageHelp: "Notes and recovery are plain text on this device. No cloud sync.",
      openFolder: "Open folder",

      groupAppearance: "Appearance",
      groupAppearanceDesc: "Look and font",
      groupEditor: "Editor",
      groupEditorDesc: "Typing and text display",
      groupSaving: "Saving",
      groupSavingDesc: "File saving",
      groupStartup: "Startup & data",
      groupStartupDesc: "App launch and local data",

      setLanguage: "Language",
      setLanguageHelp: "Interface language",
      langEnglish: "English",
      langThai: "ไทย",
      setTheme: "Theme",
      setThemeHelp: "Choose a theme or follow the system",
      optSystem: "System",
      optLight: "Light",
      optDark: "Dark",
      setFontFamily: "Font family",
      setFontFamilyHelp: "A font installed on this device. Leave empty for the default monospace.",
      setFontSize: "Font size",
      setFontSizeHelp: "Editor text size in pixels",
      setFontWeight: "Font weight",
      setFontWeightHelp: "Some fonts do not include every weight",
      setLineHeight: "Line spacing",
      setLineHeightHelp: "Line spacing relative to font size",
      setSidebar: "Show sidebar",
      setSidebarHelp: "Show the note list on the left",
      setLineNumbers: "Line numbers",
      setLineNumbersHelp: "Show line numbers when word wrap is off",
      setWrap: "Word wrap",
      setWrapHelp: "Wrap lines to the window width without adding newlines to the file",
      setSpellcheck: "Spell check",
      setSpellcheckHelp: "Check spelling using the languages the system and WebView support",
      setAutoIndent: "Auto indent",
      setAutoIndentHelp: "Keep indentation and indent after brackets when pressing Enter",
      setSoftTabs: "Use spaces for Tab",
      setSoftTabsHelp: "Insert spaces instead of tab characters",
      setTabSize: "Tab size",
      setTabSizeHelp: "Number of spaces or tab width",
      setPreview: "Markdown preview",
      setPreviewHelp: "Show a Markdown preview beside the editor",
      setAutosave: "Autosave",
      setAutosaveHelp: "Save files that already have a location after you stop typing. New notes still need their first Save.",
      setAutosaveDelay: "Autosave delay",
      setAutosaveDelayHelp: "Wait time after typing stops (milliseconds)",
      setDefaultEol: "New note line endings",
      setDefaultEolHelp: "Only for new notes. Open files keep their current format.",
      optLf: "LF",
      optCrlf: "CRLF (Windows)",
      setReopenLast: "Reopen last note",
      setReopenLastHelp: "Open the last note when the app starts (recovered notes come first)",

      keyboardShortcuts: "Keyboard shortcuts",
      keyboard: "Keyboard",
      scSettings: "Settings",
      scNewNote: "New note",
      scOpenFile: "Open file",
      scSave: "Save",
      scSaveAs: "Save as",
      scQuickOpen: "Quick open / recents",
      scCommandPalette: "Command palette",
      scCloseNote: "Close note",
      scFind: "Find",
      scReplace: "Replace",
      scFindNext: "Find next / previous",
      scGoto: "Go to line",
      scToggleSidebar: "Toggle sidebar",
      scWordWrap: "Word wrap",
      scPreview: "Markdown preview",
      scTheme: "Cycle theme",
      scFontSize: "Font size",
      scZen: "Zen mode",
      scZenKeys: "toggle from View",
      scQuit: "Quit",
      scShortcuts: "Keyboard shortcuts",

      aboutTitle: "About NISIO Note",
      aboutVersion: "Version",
      aboutRuntime: "Runtime",
      aboutRenderer: "Renderer",
      aboutStorage: "Storage",
      aboutRuntimeValue: "{bun} — TypeScript main process",
      aboutRendererValue: "System webview (WebView2 on Windows)",
      aboutWhyTitle: "Why it is small",
      aboutWhy: "NISIO Note does not bundle Chromium or Node. It runs on Bun and draws its UI with the webview that ships with the operating system, so the download is a single executable and memory use stays close to a browser tab.",
      aboutDataTitle: "Your data",
      aboutData: "Notes are plain UTF-8 files. Settings, the recent list and one recovery snapshot live in the storage folder above. Nothing is sent anywhere.",

      cmdSettings: "Settings…",
      cmdNew: "New note",
      cmdOpen: "Open file…",
      cmdRecent: "Quick open / recent files",
      cmdSave: "Save",
      cmdSaveAs: "Save as…",
      cmdReveal: "Reveal in Explorer",
      cmdClose: "Close note",
      cmdQuit: "Quit NISIO Note",
      cmdUndo: "Undo",
      cmdRedo: "Redo",
      cmdCut: "Cut",
      cmdCopy: "Copy",
      paste: "Paste",
      cmdSelectAll: "Select all",
      cmdFind: "Find",
      cmdReplace: "Replace",
      cmdGoto: "Go to line…",
      cmdWrap: "Word wrap",
      cmdLineNumbers: "Line numbers",
      cmdSidebar: "Sidebar",
      cmdPreview: "Markdown preview",
      cmdAutosave: "Autosave saved files",
      cmdTheme: "Cycle theme",
      cmdFontSettings: "Font settings…",
      cmdFontUp: "Increase font size",
      cmdFontDown: "Decrease font size",
      cmdFontReset: "Reset font size",
      cmdZen: "Zen mode",
      cmdShortcuts: "Keyboard shortcuts",
      cmdAbout: "About NISIO Note",
      cmdData: "Open app data folder",
      cmdClearRecents: "Clear recent files",

      ctxPasteImage: "Paste image from clipboard",
      ctxFind: "Find…",
      ctxReplace: "Replace…",

      couldNotStart: "NISIO Note could not start",
      recoveredChanges: "Recovered unsaved changes to “{name}” from {when}.",
      recoveredNote: "Recovered an unsaved note from {when}.",

      welcome: `NISIO Note
==========

A tiny notepad built with Bun + the system webview.
No Electron, no Chromium download, no telemetry.

Start typing here, or open a file with Ctrl+O.

Handy keys
----------
Ctrl+N          new note
Ctrl+O          open a file
Ctrl+S          save
Ctrl+P          quick open / recent files
Ctrl+F          find
Ctrl+H          replace
Ctrl+Shift+V    markdown preview
Ctrl+B          toggle sidebar
Alt+Z           toggle word wrap
Ctrl+Shift+D    cycle theme
Ctrl+Shift+P    command palette

    Drop a text file, then select the original to open it.
Paste an image with Ctrl+V, or drop an image file, to attach it.

Your work is recovered automatically if the app closes unexpectedly.
`,
    },
    th: {
      somethingWrong: "เกิดข้อผิดพลาด",
      untitled: "โน้ตไม่มีชื่อ",
      cancel: "ยกเลิก",
      ok: "ตกลง",
      close: "ปิด",
      save: "บันทึก",
      open: "เปิด",
      reload: "โหลดใหม่",
      discard: "ทิ้ง",
      clear: "ล้าง",
      create: "สร้าง",
      overwrite: "เขียนทับ?",
      reset: "รีเซ็ต",
      remove: "ลบ",

      justNow: "เมื่อสักครู่",
      minuteAgo: "1 นาทีที่แล้ว",
      minutesAgo: "{n} นาทีที่แล้ว",
      hourAgo: "1 ชั่วโมงที่แล้ว",
      hoursAgo: "{n} ชั่วโมงที่แล้ว",
      dayAgo: "1 วันที่แล้ว",
      daysAgo: "{n} วันที่แล้ว",

      chars: "{n} ตัวอักษร",
      words: "{n} คำ",
      manyWords: "หลายคำ",
      lineCol: "บรรทัด {line} คอลัมน์ {col}",
      selected: "เลือก {n}",
      unsaved: "ยังไม่บันทึก",
      saved: "บันทึกแล้ว",
      autosaved: "บันทึกอัตโนมัติแล้ว",
      notSavedYet: "ยังไม่ได้บันทึก",

      themeTitle: "ธีม: {theme} (Ctrl+Shift+D)",
      themeAuto: "ตามระบบ",
      themeLight: "สว่าง",
      themeDark: "มืด",
      themeToast: "ธีม: {theme}",
      cycleTheme: "สลับธีม",

      winMinimize: "ย่อหน้าต่าง",
      winMaximize: "ขยายหน้าต่าง",
      winRestore: "คืนขนาด",
      winClose: "ปิด",

      toggleSidebarTitle: "เปิด/ปิดรายการโน้ต (Ctrl+B)",
      toggleSidebarLabel: "เปิด/ปิดรายการโน้ต",
      allCommandsTitle: "คำสั่งทั้งหมด (Ctrl+Shift+P)",
      allCommandsLabel: "คำสั่งทั้งหมด",
      menuFile: "ไฟล์",
      menuEdit: "แก้ไข",
      menuView: "มุมมอง",
      menuHelp: "ช่วยเหลือ",
      mainMenu: "เมนูหลัก",
      openTitle: "เปิดไฟล์ (Ctrl+O)",
      saveTitle: "บันทึก (Ctrl+S)",
      cycleThemeTitle: "สลับธีม (Ctrl+Shift+D)",
      settingsTitle: "การตั้งค่า (Ctrl+,)",
      settingsLabel: "การตั้งค่า",

      recentFilesLabel: "ไฟล์ล่าสุด",
      recentLabel: "ล่าสุด",
      clearRecentsTitle: "ล้างไฟล์ล่าสุด",
      searchNotesPlaceholder: "ค้นหาโน้ต…",
      searchNotesAria: "ค้นหาจากชื่อ ID หรือข้อความในโน้ต",
      newNote: "โน้ตใหม่",
      browseFiles: "เลือกไฟล์…",
      resizeSidebarLabel: "ปรับขนาดแถบข้าง",
      resizeSidebarTitle: "ลากเพื่อปรับขนาดแถบข้าง · ดับเบิลคลิกเพื่อรีเซ็ต",

      dismiss: "ปิด",

      findPlaceholder: "ค้นหา",
      matchCase: "ตรงตามตัวพิมพ์",
      regex: "นิพจน์ปกติ",
      prevMatch: "ผลก่อนหน้า (Shift+F3)",
      nextMatch: "ผลถัดไป (F3)",
      closeEsc: "ปิด (Esc)",
      replaceWith: "แทนที่ด้วย",
      replace: "แทนที่",
      replaceAll: "แทนที่ทั้งหมด",

      noteContent: "เนื้อหาโน้ต",
      resizePreviewLabel: "ปรับขนาดตัวอย่าง Markdown",
      resizePreviewTitle: "ลากเพื่อปรับขนาดตัวอย่าง · ดับเบิลคลิกเพื่อรีเซ็ต",
      markdownPreview: "ตัวอย่าง Markdown",

      revealInExplorer: "แสดงใน Explorer",
      toggleLineEndings: "สลับรูปแบบบรรทัด",
      encoding: "การเข้ารหัส",

      noRecentFiles: "ยังไม่มีไฟล์ล่าสุด เปิดไฟล์ด้วย Ctrl+O",
      noMatchingNotes: "ไม่พบโน้ตที่ตรงกับคำค้น",
      searching: "กำลังค้นหา…",
      searchResults: "{n} ผลลัพธ์",
      searchTruncated: " · แสดงบางส่วน (ถึงขีดจำกัดค้นหา)",
      removedFromRecents: "ลบออกจากไฟล์ล่าสุดแล้ว",
      clearRecentsMessage: "ลบรายการทั้งหมดในไฟล์ล่าสุดหรือไม่ ไฟล์ของคุณจะไม่ถูกลบ",
      recentsCleared: "ล้างไฟล์ล่าสุดแล้ว",
      pinNote: "ปักหมุดโน้ต",
      unpinNote: "เลิกปักหมุด",
      pinAdded: "ปักหมุดโน้ตแล้ว",
      pinRemoved: "เลิกปักหมุดแล้ว",
      pinnedNote: "ปักหมุด",
      openFile: "เปิดไฟล์",
      showInExplorer: "แสดงใน Explorer",
      removeFromRecents: "ลบออกจากไฟล์ล่าสุด",

      unsavedTitle: "มีการแก้ไขที่ยังไม่บันทึก",
      unsavedMessage: "“{name}” มีการแก้ไขที่ยังไม่บันทึก บันทึกก่อน{action}หรือไม่",
      actionOpening: "เปิด “{name}”",
      actionNewNote: "เริ่มโน้ตใหม่",
      actionQuitting: "ออกจากแอป",
      actionDropped: "เปิดไฟล์ที่ลากมา",

      savedToast: "บันทึก {name} แล้ว",
      fileChangedReloaded: "ไฟล์เปลี่ยนบนดิสก์ — โหลดใหม่แล้ว",
      fileChangedBanner: "ไฟล์นี้เปลี่ยนบนดิสก์ขณะที่คุณมีการแก้ไขที่ยังไม่บันทึก",
      keepMine: "เก็บของฉัน",
      openCopyBanner: "เปิดสำเนาของ “{name}” ใช้บันทึกเป็น (Ctrl+Shift+S) เพื่อเลือกที่จัดเก็บ",

      filterFolder: "กรองโฟลเดอร์นี้…",
      newFolder: "+ โฟลเดอร์",
      newFolderName: "ชื่อโฟลเดอร์ใหม่",
      fileName: "ชื่อไฟล์",
      openDialogTitle: "เปิดไฟล์",
      saveAsTitle: "บันทึกเป็น",
      loading: "กำลังโหลด…",
      nothingMatchesFilter: "ไม่มีรายการที่ตรงกับตัวกรอง",
      folderEmpty: "โฟลเดอร์นี้ว่าง",
      parentFolder: "โฟลเดอร์แม่",
      selectFileFirst: "เลือกไฟล์ก่อน",
      enterFileName: "ใส่ชื่อไฟล์",
      invalidFileName: 'ชื่อไฟล์ต้องไม่มี \\ / : * ? " < > |',
      createdFolder: "สร้างโฟลเดอร์ {name} แล้ว",

      palettePlaceholder: "ค้นหาคำสั่งและไฟล์ล่าสุด…",
      paletteMove: "↑↓ เลื่อน",
      paletteRun: "↵ เรียกใช้",
      paletteClose: "esc ปิด",
      noMatches: "ไม่พบรายการ",

      invalidPattern: "รูปแบบค้นหาไม่ถูกต้อง",
      noMatchesReplace: "ไม่มีรายการให้แทนที่",
      replacedOne: "แทนที่ 1 แห่ง",
      replacedMany: "แทนที่ {n} แห่ง",
      goToLine: "ไปยังบรรทัด",
      lineNumber: "หมายเลขบรรทัด",
      enterNumber: "ใส่ตัวเลข",
      notSavedYetToast: "โน้ตนี้ยังไม่ได้บันทึก",

      notImage: "ไฟล์นี้ไม่ใช่รูปภาพ",
      imageTooLarge: "รูปมีขนาดเกิน 25 MB",
      imageConvertFail: "แปลงรูปภาพไม่สำเร็จ",
      imageInserted: "แทรกรูปแล้ว · เก็บไว้ในเครื่อง",
      imagePasted: "วางรูปจากคลิปบอร์ดแล้ว",
      noClipboardImage: "ไม่มีรูปในคลิปบอร์ด",

      nothingToPreview: "ยังไม่มีอะไรให้แสดงตัวอย่าง",
      missingImage: "ไม่พบรูปภาพ ({id})",
      autosaveOn: "เปิดบันทึกอัตโนมัติ",
      autosaveOff: "ปิดบันทึกอัตโนมัติ",
      lineEndings: "รูปแบบบรรทัด: {eol}",
      utf8Info: "NISIO Note อ่านและเขียนเป็น UTF-8",
      dropTooLarge: "ไฟล์มีขนาดเกิน 20 MB",
      dropBinary: "ไฟล์ไบนารีแก้ไขที่นี่ไม่ได้",
      dropLooksBinary: "ดูเหมือนเป็นไฟล์ไบนารี",
      dropChooseOriginal: "เลือกไฟล์ต้นฉบับเพื่อเปิดและบันทึกกลับไฟล์เดิม",

      fontSettings: "ตั้งค่าฟอนต์",
      installedFonts: "ฟอนต์ที่ติดตั้ง",
      closeFontSettings: "ปิดตั้งค่าฟอนต์",
      fontFamily: "ตระกูลฟอนต์",
      fontPlaceholder: "Consolas (ค่าเริ่มต้น Notepad)",
      size: "ขนาด",
      weight: "น้ำหนัก",
      lineSpacing: "ระยะบรรทัด",
      weightThin: "บางมาก",
      weightExtraLight: "บางพิเศษ",
      weightLight: "บาง",
      weightRegular: "ปกติ",
      weightMedium: "กลาง",
      weightSemibold: "กึ่งหนา",
      weightBold: "หนา",
      weightExtraBold: "หนาพิเศษ",
      weightBlack: "หนามาก",
      readingFonts: "กำลังอ่านฟอนต์ที่ติดตั้ง…",
      enterFontManually: "พิมพ์ชื่อฟอนต์เอง",
      fontsFound: "พบ {n} ฟอนต์ · พิมพ์เพื่อค้นหา",

      settingsSearchPlaceholder: "ค้นหาการตั้งค่า…",
      closeSettings: "ปิดการตั้งค่า",
      settingsCategories: "หมวดหมู่การตั้งค่า",
      changesApply: "การเปลี่ยนแปลงมีผลทันที · บันทึกอัตโนมัติ",
      resetPreferences: "รีเซ็ตการตั้งค่า",
      confirmReset: "ยืนยันรีเซ็ต (โน้ตยังอยู่)",
      savingSettings: "กำลังบันทึก…",
      settingsSaveFailed: "บันทึกการตั้งค่าไม่สำเร็จ",
      settingsSaved: "บันทึกแล้ว · บันทึกอัตโนมัติ",
      noMatchingSettings: "ไม่พบการตั้งค่า",
      localStorage: "ที่จัดเก็บในเครื่อง",
      localStorageHelp: "โน้ตและ recovery เป็น plain text บนเครื่อง ไม่มี cloud sync",
      openFolder: "เปิดโฟลเดอร์",

      groupAppearance: "หน้าตา",
      groupAppearanceDesc: "หน้าตาและฟอนต์",
      groupEditor: "ตัวแก้ไข",
      groupEditorDesc: "การพิมพ์และการแสดงข้อความ",
      groupSaving: "การบันทึก",
      groupSavingDesc: "การบันทึกไฟล์",
      groupStartup: "เริ่มต้นและข้อมูล",
      groupStartupDesc: "การเปิดแอปและข้อมูลในเครื่อง",

      setLanguage: "ภาษา",
      setLanguageHelp: "ภาษาของหน้าจอ",
      langEnglish: "English",
      langThai: "ไทย",
      setTheme: "ธีม",
      setThemeHelp: "เลือกธีม หรือใช้ตามการตั้งค่าระบบ",
      optSystem: "ตามระบบ",
      optLight: "สว่าง",
      optDark: "มืด",
      setFontFamily: "ตระกูลฟอนต์",
      setFontFamilyHelp: "ฟอนต์ที่ติดตั้งในเครื่อง เว้นว่างเพื่อใช้ monospace เริ่มต้น",
      setFontSize: "ขนาดตัวอักษร",
      setFontSizeHelp: "ขนาดตัวอักษรใน editor (px)",
      setFontWeight: "น้ำหนักฟอนต์",
      setFontWeightHelp: "บางฟอนต์อาจไม่มีครบทุกน้ำหนัก",
      setLineHeight: "ระยะห่างบรรทัด",
      setLineHeightHelp: "ระยะห่างบรรทัดเทียบกับขนาดตัวอักษร",
      setSidebar: "แสดงแถบข้าง",
      setSidebarHelp: "แสดงรายการโน้ตด้านซ้าย",
      setLineNumbers: "เลขบรรทัด",
      setLineNumbersHelp: "แสดงเลขบรรทัดเมื่อปิด word wrap",
      setWrap: "ตัดบรรทัด",
      setWrapHelp: "ตัดบรรทัดตามความกว้างหน้าต่าง โดยไม่เพิ่ม newline ในไฟล์",
      setSpellcheck: "ตรวจสะกด",
      setSpellcheckHelp: "ตรวจสะกดตามภาษาที่ระบบและ WebView รองรับ",
      setAutoIndent: "เยื้องอัตโนมัติ",
      setAutoIndentHelp: "คงระยะเยื้องและเพิ่มเยื้องหลังวงเล็บเมื่อกด Enter",
      setSoftTabs: "ใช้ช่องว่างแทน Tab",
      setSoftTabsHelp: "ใช้ช่องว่างแทนตัวอักษร Tab",
      setTabSize: "ขนาด Tab",
      setTabSizeHelp: "จำนวนช่องว่างหรือความกว้างของ Tab",
      setPreview: "ตัวอย่าง Markdown",
      setPreviewHelp: "แสดงตัวอย่าง Markdown ด้านข้าง editor",
      setAutosave: "บันทึกอัตโนมัติ",
      setAutosaveHelp: "บันทึกไฟล์ที่มีตำแหน่งแล้วหลังหยุดพิมพ์ โน้ตใหม่ยังต้องกด Save ครั้งแรก",
      setAutosaveDelay: "หน่วงเวลาบันทึกอัตโนมัติ",
      setAutosaveDelayHelp: "ระยะรอหลังหยุดพิมพ์ (มิลลิวินาที)",
      setDefaultEol: "รูปแบบบรรทัดของโน้ตใหม่",
      setDefaultEolHelp: "ใช้กับโน้ตใหม่เท่านั้น ไฟล์ที่เปิดอยู่คงรูปแบบเดิม",
      optLf: "LF",
      optCrlf: "CRLF (Windows)",
      setReopenLast: "เปิดโน้ตล่าสุด",
      setReopenLastHelp: "เปิดโน้ตล่าสุดเมื่อเริ่มแอป (โน้ตที่กู้คืนได้จะมีลำดับก่อน)",

      keyboardShortcuts: "คีย์ลัด",
      keyboard: "แป้นพิมพ์",
      scSettings: "การตั้งค่า",
      scNewNote: "โน้ตใหม่",
      scOpenFile: "เปิดไฟล์",
      scSave: "บันทึก",
      scSaveAs: "บันทึกเป็น",
      scQuickOpen: "เปิดด่วน / ไฟล์ล่าสุด",
      scCommandPalette: "พาเลตคำสั่ง",
      scCloseNote: "ปิดโน้ต",
      scFind: "ค้นหา",
      scReplace: "แทนที่",
      scFindNext: "ค้นหาถัดไป / ก่อนหน้า",
      scGoto: "ไปยังบรรทัด",
      scToggleSidebar: "เปิด/ปิดแถบข้าง",
      scWordWrap: "ตัดบรรทัด",
      scPreview: "ตัวอย่าง Markdown",
      scTheme: "สลับธีม",
      scFontSize: "ขนาดตัวอักษร",
      scZen: "โหมดสงบ",
      scZenKeys: "เปิดจากเมนูมุมมอง",
      scQuit: "ออก",
      scShortcuts: "คีย์ลัด",

      aboutTitle: "เกี่ยวกับ NISIO Note",
      aboutVersion: "เวอร์ชัน",
      aboutRuntime: "รันไทม์",
      aboutRenderer: "ตัวแสดงผล",
      aboutStorage: "ที่จัดเก็บ",
      aboutRuntimeValue: "{bun} — กระบวนการหลัก TypeScript",
      aboutRendererValue: "เว็บวิวของระบบ (WebView2 บน Windows)",
      aboutWhyTitle: "ทำไมจึงเล็ก",
      aboutWhy: "NISIO Note ไม่ได้รวม Chromium หรือ Node ไว้ด้วย ทำงานบน Bun และวาด UI ด้วยเว็บวิวที่มากับระบบปฏิบัติการ ดาวน์โหลดเป็นไฟล์เดียว และใช้หน่วยความจำใกล้เคียงแท็บเบราว์เซอร์",
      aboutDataTitle: "ข้อมูลของคุณ",
      aboutData: "โน้ตเป็นไฟล์ UTF-8 ธรรมดา การตั้งค่า รายการไฟล์ล่าสุด และ snapshot สำหรับกู้คืนหนึ่งชุดอยู่ในโฟลเดอร์ที่จัดเก็บด้านบน ไม่มีการส่งข้อมูลออกไปที่ใด",

      cmdSettings: "การตั้งค่า…",
      cmdNew: "โน้ตใหม่",
      cmdOpen: "เปิดไฟล์…",
      cmdRecent: "เปิดด่วน / ไฟล์ล่าสุด",
      cmdSave: "บันทึก",
      cmdSaveAs: "บันทึกเป็น…",
      cmdReveal: "แสดงใน Explorer",
      cmdClose: "ปิดโน้ต",
      cmdQuit: "ออกจาก NISIO Note",
      cmdUndo: "เลิกทำ",
      cmdRedo: "ทำซ้ำ",
      cmdCut: "ตัด",
      cmdCopy: "คัดลอก",
      paste: "วาง",
      cmdSelectAll: "เลือกทั้งหมด",
      cmdFind: "ค้นหา",
      cmdReplace: "แทนที่",
      cmdGoto: "ไปยังบรรทัด…",
      cmdWrap: "ตัดบรรทัด",
      cmdLineNumbers: "เลขบรรทัด",
      cmdSidebar: "แถบข้าง",
      cmdPreview: "ตัวอย่าง Markdown",
      cmdAutosave: "บันทึกอัตโนมัติสำหรับไฟล์ที่บันทึกแล้ว",
      cmdTheme: "สลับธีม",
      cmdFontSettings: "ตั้งค่าฟอนต์…",
      cmdFontUp: "เพิ่มขนาดตัวอักษร",
      cmdFontDown: "ลดขนาดตัวอักษร",
      cmdFontReset: "รีเซ็ตขนาดตัวอักษร",
      cmdZen: "โหมดสงบ",
      cmdShortcuts: "คีย์ลัด",
      cmdAbout: "เกี่ยวกับ NISIO Note",
      cmdData: "เปิดโฟลเดอร์ข้อมูลแอป",
      cmdClearRecents: "ล้างไฟล์ล่าสุด",

      ctxPasteImage: "วางรูปจากคลิปบอร์ด",
      ctxFind: "ค้นหา…",
      ctxReplace: "แทนที่…",

      couldNotStart: "NISIO Note เริ่มทำงานไม่ได้",
      recoveredChanges: "กู้คืนการแก้ไขที่ยังไม่บันทึกของ “{name}” จาก {when} แล้ว",
      recoveredNote: "กู้คืนโน้ตที่ยังไม่บันทึกจาก {when} แล้ว",

      welcome: `NISIO Note
==========

โน้ตเล็ก ๆ สร้างด้วย Bun + เว็บวิวของระบบ
ไม่ใช้ Electron ไม่ต้องดาวน์โหลด Chromium ไม่มี telemetry

เริ่มพิมพ์ที่นี่ หรือเปิดไฟล์ด้วย Ctrl+O

คีย์ที่ใช้บ่อย
--------------
Ctrl+N          โน้ตใหม่
Ctrl+O          เปิดไฟล์
Ctrl+S          บันทึก
Ctrl+P          เปิดด่วน / ไฟล์ล่าสุด
Ctrl+F          ค้นหา
Ctrl+H          แทนที่
Ctrl+Shift+V    ตัวอย่าง Markdown
Ctrl+B          เปิด/ปิดแถบข้าง
Alt+Z           ตัดบรรทัด
Ctrl+Shift+D    สลับธีม
Ctrl+Shift+P    พาเลตคำสั่ง

    ลากไฟล์ข้อความมาวาง แล้วเลือกไฟล์ต้นฉบับเพื่อเปิด
วางรูปด้วย Ctrl+V หรือลากไฟล์รูปมาเพื่อแนบ

งานของคุณจะถูกกู้คืนอัตโนมัติหากแอปปิดกะทันหัน
`,
    },
  };

  function t(key, vars) {
    const lang = S.settings.lang === "th" ? "th" : "en";
    let text = STRINGS[lang][key];
    if (text == null) text = STRINGS.en[key];
    if (text == null) return key;
    if (vars) {
      text = String(text).replace(/\{(\w+)\}/g, (match, name) =>
        vars[name] != null ? String(vars[name]) : match,
      );
    }
    return String(text);
  }

  function welcomeText() {
    return t("welcome");
  }

  const dom = {
    app: $("app"),
    editor: createEditor($("editor")),
    gutter: $("gutter"),
    gutterLines: $("gutter-lines"),
    panes: $("panes"),
    sidebarResizer: $("sidebar-resizer"),
    paneResizer: $("pane-resizer"),
    backdrop: $("drawer-backdrop"),
    preview: $("preview-pane"),
    findbar: $("findbar"),
    findInput: $("find-input"),
    replaceRow: $("replace-row"),
    replaceInput: $("replace-input"),
    findCount: $("find-count"),
    banner: $("banner"),
    bannerText: $("banner-text"),
    bannerActions: $("banner-actions"),
    modals: $("modal-root"),
    menu: $("menu"),
    toasts: $("toasts"),
    state: $("st-state"),
  };

  /* ------------------------------------------------------------------ */
  /* theme, font, chrome                                                */
  /* ------------------------------------------------------------------ */

  let darkQuery = null;
  try {
    darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    darkQuery = null;
  }

  let narrowQuery = null;
  try {
    narrowQuery = window.matchMedia("(max-width: 760px)");
  } catch {
    narrowQuery = null;
  }

  function effectiveTheme() {
    const preference = S.settings.theme;
    if (preference === "light" || preference === "dark") return preference;
    return darkQuery && darkQuery.matches ? "dark" : "light";
  }

  function themeLabel(value) {
    return t(value === "dark" ? "themeDark" : value === "light" ? "themeLight" : "themeAuto");
  }

  function applyTheme() {
    const theme = effectiveTheme();
    document.body.classList.toggle("theme-dark", theme === "dark");
    document.body.classList.toggle("theme-light", theme === "light");
    const button = $("btn-theme");
    if (button) {
      button.innerHTML = S.settings.theme === "auto"
        ? ICONS.themeAuto
        : theme === "dark" ? ICONS.themeDark : ICONS.themeLight;
      button.title = t("themeTitle", { theme: themeLabel(S.settings.theme) });
    }
  }

  function applyFont(refreshGutter = true) {
    const size = clamp(Number(S.settings.fontSize) || 15, 10, 32);
    document.documentElement.style.setProperty("--font-size", `${size}px`);
    document.documentElement.style.setProperty("--lh", `${Math.round(size * (S.settings.lineHeight || 1.62))}px`);
    const family = S.settings.fontFamily;
    const font = family ? `${JSON.stringify(family)}, var(--mono)` : "var(--mono)";
    dom.editor.style.fontFamily = font;
    dom.gutter.style.fontFamily = font;
    dom.editor.style.fontWeight = String(S.settings.fontWeight || 400);
    dom.editor.style.fontSize = `${size}px`;
    dom.editor.style.tabSize = String(S.settings.tabSize || 2);
    dom.editor.measure();
    if (refreshGutter) updateGutter(true);
    syncFontPanel();
  }

  function applyLayoutSizes() {
    const sidebarWidth = clamp(Number(S.settings.sidebarWidth) || 218, 160, 520);
    const previewWidth = clamp(Number(S.settings.previewWidth) || 50, 20, 80);
    document.documentElement.style.setProperty("--sidebar", `${sidebarWidth}px`);
    document.documentElement.style.setProperty("--preview-size", `${previewWidth}%`);
    dom.sidebarResizer.hidden = !S.settings.sidebar;
    dom.paneResizer.hidden = !S.settings.preview;
  }

  let appliedLang = null;

  function applyLanguage() {
    const lang = S.settings.lang === "th" ? "th" : "en";
    if (lang === appliedLang) return;
    appliedLang = lang;
    document.documentElement.lang = lang;
    const setText = (id, key) => {
      const node = $(id);
      if (node) node.textContent = t(key);
    };
    const setTitle = (id, key) => {
      const node = $(id);
      if (node) node.title = t(key);
    };
    const setAria = (id, key) => {
      const node = $(id);
      if (node) node.setAttribute("aria-label", t(key));
    };
    const setPlaceholder = (id, key) => {
      const node = $(id);
      if (node) node.placeholder = t(key);
    };
    const setTrailing = (id, key) => {
      const node = $(id);
      if (!node) return;
      for (const child of node.childNodes) {
        if (child.nodeType === 3 && child.nodeValue.trim()) {
          child.nodeValue = ` ${t(key)}`;
          return;
        }
      }
      node.append(document.createTextNode(` ${t(key)}`));
    };

    setTitle("btn-sidebar", "toggleSidebarTitle");
    setAria("btn-sidebar", "toggleSidebarLabel");
    setTitle("btn-menu", "allCommandsTitle");
    setAria("btn-menu", "allCommandsLabel");
    const menuKeys = { file: "menuFile", edit: "menuEdit", view: "menuView", help: "menuHelp" };
    document.querySelectorAll(".menubtn").forEach((button) => {
      const key = menuKeys[button.dataset.menu];
      if (key) button.textContent = t(key);
    });
    setText("btn-open", "open");
    setTitle("btn-open", "openTitle");
    updateSaveButton();
    setAria("btn-theme", "cycleThemeTitle");
    setTitle("btn-settings", "settingsTitle");
    setAria("btn-settings", "settingsLabel");
    const maximize = $("window-maximize");
    if (maximize) {
      maximize.title = S.maximized ? t("winRestore") : t("winMaximize");
      maximize.setAttribute("aria-label", maximize.title);
    }
    setTitle("window-minimize", "winMinimize");
    setAria("window-minimize", "winMinimize");
    setTitle("window-close", "winClose");
    setAria("window-close", "winClose");
    const sidebar = $("sidebar");
    if (sidebar) sidebar.setAttribute("aria-label", t("recentFilesLabel"));
    const head = document.querySelector(".side-head > span");
    if (head) head.textContent = t("recentLabel");
    setText("btn-clear-recents", "clear");
    setTitle("btn-clear-recents", "clearRecentsTitle");
    setPlaceholder("note-search", "searchNotesPlaceholder");
    setAria("note-search", "searchNotesAria");
    setTrailing("btn-new", "newNote");
    setTrailing("btn-browse", "browseFiles");
    setAria("sidebar-resizer", "resizeSidebarLabel");
    setTitle("sidebar-resizer", "resizeSidebarTitle");
    setTitle("banner-close", "dismiss");
    setAria("banner-close", "dismiss");
    setPlaceholder("find-input", "findPlaceholder");
    setTitle("find-case", "matchCase");
    setTitle("find-regex", "regex");
    setTitle("find-prev", "prevMatch");
    setTitle("find-next", "nextMatch");
    setTitle("find-close", "closeEsc");
    setPlaceholder("replace-input", "replaceWith");
    setText("replace-one", "replace");
    setText("replace-all", "replaceAll");
    const editor = $("editor");
    if (editor) editor.setAttribute("aria-label", t("noteContent"));
    setAria("pane-resizer", "resizePreviewLabel");
    setTitle("pane-resizer", "resizePreviewTitle");
    const preview = $("preview-pane");
    if (preview) preview.setAttribute("aria-label", t("markdownPreview"));
    setTitle("st-eol", "toggleLineEndings");
    setTitle("st-enc", "encoding");

    if (fontPanel) {
      fontPanel.remove();
      fontPanel = null;
      fontListLoaded = false;
      fontListLoading = false;
    }
  }

  function applyResponsive() {
    S.drawerMode = !!(narrowQuery && narrowQuery.matches);
    document.body.classList.toggle("drawer-mode", S.drawerMode);
    document.body.classList.toggle("drawer-open", S.drawerMode && S.settings.sidebar);
    document.body.classList.toggle("no-sidebar", !S.settings.sidebar);
    dom.backdrop.hidden = !(S.drawerMode && S.settings.sidebar);
    $("btn-sidebar").setAttribute("aria-pressed", S.settings.sidebar ? "true" : "false");
  }

  function applyThemeAndChrome() {
    applyLanguage();
    applyTheme();
    applyFont(false);
    applyLayoutSizes();
    dom.gutter.hidden = !!S.settings.wrap || !S.settings.lineNumbers;
    dom.editor.setAttribute("wrap", S.settings.wrap ? "soft" : "off");
    dom.editor.spellcheck = !!S.settings.spellcheck;
    dom.editor.configure(S.settings);
    dom.panes.classList.toggle("wrap", !!S.settings.wrap);
    applyResponsive();
    dom.preview.hidden = !S.settings.preview;
    document.body.classList.toggle("zen", S.zen);
    updateGutter(true);
  }

  function setupSplitter(handle, options) {
    let drag = null;
    const direction = options.direction || 1;

    const finish = (event) => {
      if (!drag) return;
      drag = null;
      handle.classList.remove("active");
      document.body.classList.remove("col-resizing");
      if (event && handle.hasPointerCapture?.(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      options.commit();
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { startX: event.clientX, start: options.read() };
      handle.classList.add("active");
      document.body.classList.add("col-resizing");
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic or already-released pointer */
      }
      handle.focus({ preventScroll: true });
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag) return;
      options.write(drag.start + (event.clientX - drag.startX) * direction);
    });
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("dblclick", () => {
      options.write(options.reset());
      options.commit();
    });
    handle.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 48 : 16;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        options.write(options.read() - step * direction);
        options.commit();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        options.write(options.read() + step * direction);
        options.commit();
      } else if (event.key === "Home") {
        event.preventDefault();
        options.write(options.reset());
        options.commit();
      }
    });
  }

  function bindSplitters() {
    const sidebarWidth = () => clamp(Number(S.settings.sidebarWidth) || 218, 160, 520);
    const setSidebarWidth = (width) => {
      const max = Math.max(160, Math.min(520, window.innerWidth - 360));
      const next = Math.round(clamp(width, 160, max));
      S.settings.sidebarWidth = next;
      document.documentElement.style.setProperty("--sidebar", `${next}px`);
    };
    setupSplitter(dom.sidebarResizer, {
      read: sidebarWidth,
      write: setSidebarWidth,
      reset: () => 218,
      commit: () => persistSettings({ sidebarWidth: S.settings.sidebarWidth }),
    });

    const panesWidth = () => Math.max(1, dom.panes.clientWidth);
    const previewWidth = () => dom.preview.getBoundingClientRect().width;
    const setPreviewWidth = (width) => {
      const percent = clamp((width / panesWidth()) * 100, 20, 80);
      S.settings.previewWidth = Math.round(percent);
      document.documentElement.style.setProperty("--preview-size", `${percent}%`);
    };
    setupSplitter(dom.paneResizer, {
      read: previewWidth,
      write: setPreviewWidth,
      reset: () => panesWidth() / 2,
      direction: -1,
      commit: () => persistSettings({ previewWidth: S.settings.previewWidth }),
    });
  }

  /* ------------------------------------------------------------------ */
  /* editor metrics                                                     */
  /* ------------------------------------------------------------------ */

  let lineIndexDirty = false;

  function rebuildLineIndex() {
    S.lineCount = dom.editor.lineCount;
    lineIndexDirty = false;
  }

  function ensureLineIndex() {
    if (lineIndexDirty) rebuildLineIndex();
  }

  function lineAt(position) {
    ensureLineIndex();
    return dom.editor.lineAt(position);
  }

  let gutterFirst = -1;
  let gutterLast = -1;
  let gutterFrame = 0;

  function lineHeightPx() {
    const size = clamp(Number(S.settings.fontSize) || 15, 10, 32);
    return Math.round(size * (S.settings.lineHeight || 1.62));
  }

  function renderGutterWindow(force) {
    if (dom.gutter.hidden) return;
    ensureLineIndex();
    const lh = lineHeightPx();
    const scrollTop = dom.editor.scrollTop;
    const height = dom.editor.clientHeight;
    const first = Math.min(S.lineCount - 1, Math.max(0, Math.floor(scrollTop / lh) - 24));
    const last = Math.min(S.lineCount - 1, Math.ceil((scrollTop + height) / lh) + 24);
    const transform = `translateY(${first * lh - scrollTop}px)`;
    if (dom.gutterLines.style.transform !== transform) {
      dom.gutterLines.style.transform = transform;
    }
    if (!force && first === gutterFirst && last === gutterLast) return;
    gutterFirst = first;
    gutterLast = last;
    const lines = new Array(last - first + 1);
    for (let line = first; line <= last; line++) lines[line - first] = String(line + 1);
    dom.gutterLines.textContent = lines.join("\n");
  }

  function updateGutter(force) {
    if (dom.gutter.hidden) return;
    ensureLineIndex();
    const digits = String(S.lineCount).length;
    if (!force && S.gutterCount === S.lineCount && S.gutterDigits === digits) {
      renderGutterWindow();
      return;
    }
    S.gutterCount = S.lineCount;
    S.gutterDigits = digits;
    const size = clamp(Number(S.settings.fontSize) || 15, 10, 32);
    dom.gutter.style.width = `${Math.max(44, Math.round(digits * size * 0.62) + 20)}px`;
    renderGutterWindow(true);
  }

  function syncGutterScroll() {
    if (dom.gutter.hidden || gutterFrame) return;
    gutterFrame = requestAnimationFrame(() => {
      gutterFrame = 0;
      renderGutterWindow();
    });
  }

  let segmenter = null;

  function countWords(text) {
    if (!text.trim()) return 0;
    if (segmenter || typeof Intl !== "undefined") {
      try {
        segmenter ||= new Intl.Segmenter(undefined, { granularity: "word" });
        let count = 0;
        for (const part of segmenter.segment(text)) {
          if (part.isWordLike) count++;
        }
        return count;
      } catch {
        segmenter = null;
      }
    }
    return text.trim().split(/\s+/).length;
  }

  let countsTimer = 0;

  function scheduleCounts() {
    clearTimeout(countsTimer);
    countsTimer = setTimeout(updateCounts, 160);
  }

  function updateCounts() {
    const text = dom.editor.value;
    const chars = t("chars", { n: fmtNum(text.length) });
    if ($("st-chars").textContent !== chars) $("st-chars").textContent = chars;
    const words = text.length > 250000 ? t("manyWords") : t("words", { n: fmtNum(countWords(text)) });
    if ($("st-words").textContent !== words) $("st-words").textContent = words;
  }

  function updateStatus() {
    ensureLineIndex();
    const position = dom.editor.selectionStart;
    const line = lineAt(position);
    const column = position - dom.editor.lineStart(line) + 1;
    const posText = t("lineCol", { line: line + 1, col: column });
    if ($("st-pos").textContent !== posText) $("st-pos").textContent = posText;
    const selected = dom.editor.selectionEnd - dom.editor.selectionStart;
    const selText = selected > 0 ? t("selected", { n: fmtNum(selected) }) : "";
    if ($("st-sel").textContent !== selText) $("st-sel").textContent = selText;
  }

  function updateSaveButton() {
    const button = $("btn-save");
    const saved = !!S.path && !S.dirty;
    button.textContent = t(saved ? "saved" : "save");
    button.disabled = saved;
    button.title = t(saved ? "saved" : "saveTitle");
  }

  function updateState() {
    const label = S.dirty ? t("unsaved") : S.stateLabel || (S.path ? t("saved") : "");
    dom.state.textContent = label;
    dom.state.className = `st-state${S.dirty ? " dirty" : ""}`;
    updateSaveButton();
  }

  let stateTimer = 0;

  function flashState(label) {
    S.stateLabel = label;
    updateState();
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      S.stateLabel = "";
      updateState();
    }, 2600);
  }

  let titleTimer = 0;

  function contentTitle(content) {
    return Array.from(String(content).split(/\r?\n/, 1)[0].trim() || t("untitled")).slice(0, 60).join("");
  }

  function isManagedNote() {
    if (!S.path) return true;
    return S.app && S.app.notesDir && S.dir
      && S.dir.toLowerCase() === S.app.notesDir.toLowerCase()
      && /^note-[0-9a-f-]{36}\.txt$/i.test(S.name);
  }

  function displayName() {
    return isManagedNote() ? contentTitle(dom.editor.firstLine) : S.name;
  }

  function updateTitle(immediate) {
    const name = displayName();
    $("window-title").textContent = `${S.dirty ? "• " : ""}${name}`;
    const selectedRecent = document.querySelector(".recent.active .recent-name");
    if (selectedRecent) selectedRecent.textContent = name;
    $("st-name").textContent = name;
    $("st-name").title = S.path || t("notSavedYet");
    $("st-dirty").textContent = S.dirty ? "●" : "";
    document.title = `${S.dirty ? "• " : ""}${name} — NISIO Note`;

    const send = () =>
      call("nTitle", { text: `${S.dirty ? "• " : ""}${name} — NISIO Note` });
    clearTimeout(titleTimer);
    if (immediate) send();
    else titleTimer = setTimeout(send, 140);
  }

  let metricsFrame = 0;
  let metricsNeedChrome = false;

  function scheduleEditorMetrics(includeChrome) {
    if (includeChrome) metricsNeedChrome = true;
    if (metricsFrame) return;
    metricsFrame = requestAnimationFrame(() => {
      metricsFrame = 0;
      if (lineIndexDirty) rebuildLineIndex();
      updateGutter();
      updateStatus();
      if (metricsNeedChrome) {
        metricsNeedChrome = false;
        updateState();
        updateTitle();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* document lifecycle                                                 */
  /* ------------------------------------------------------------------ */

  let documentVersion = 0;
  let saveQueue = Promise.resolve();

  function setDoc(doc) {
    documentVersion++;
    clearTimeout(autosaveTimer);
    S.path = doc.path || null;
    S.dir = doc.dir != null ? doc.dir : S.dir;
    S.name = doc.name || basenameOf(S.path) || "Untitled";
    S.eol = doc.eol === "CRLF" ? "CRLF" : "LF";
    S.bom = !!doc.bom;
    S.mtime = doc.mtime || 0;
    S.dirty = doc.dirty === true;

    dom.editor.value = doc.content || "";
    dom.editor.scrollTop = 0;
    dom.editor.scrollLeft = 0;
    dom.editor.setSelectionRange(0, 0);

    rebuildLineIndex();
    S.gutterCount = -1;
    applyThemeAndChrome();
    updateStatus();
    updateCounts();
    updateState();
    updateTitle(true);
    renderRecents();
    updateEolBadge();
    renderPreview();
    scheduleSession(true);
  }

  function startBlank(welcome) {
    setDoc({
      path: null,
      dir: S.dir,
      name: "Untitled",
      content: welcome ? welcomeText() : "",
      eol: S.settings.defaultEol || "LF",
      bom: false,
      mtime: 0,
      dirty: false,
    });
    void call("nSessionClear");
    hideBanner();
    focusEditor();
  }

  function focusEditor() {
    try {
      dom.editor.focus({ preventScroll: true });
    } catch {
      dom.editor.focus();
    }
  }

  function applyOpened(result) {
    S.recents = result.recents || S.recents;
    S.settings.recents = S.recents;
    setDoc({ ...result.file, dirty: false });
    S.dir = result.file.dir;
    S.settings.lastDir = result.file.dir;
    void call("nSettings", { patch: { lastDir: result.file.dir } });
    renderRecents();
    hideBanner();
  }

  async function openPath(path, options = {}) {
    const { force = false, silent = false } = options;
    if (!path) return false;
    if (!force && !(await guardUnsaved(t("actionOpening", { name: basenameOf(path) })))) return false;

    const result = await call("nOpen", { path });
    if (!result.ok) {
      if (!silent) toast(result.error, "err");
      if (/not found/i.test(result.error)) void removeRecent(path, true);
      return false;
    }
    applyOpened(result);

    return true;
  }

  async function openFlow() {
    const picked = await fileDialog({
      mode: "open",
      startDir: S.dir || S.settings.lastDir || null,
    });
    if (!picked) return;
    await openPath(picked.path);
  }

  function defaultSaveName() {
    let name = contentTitle(dom.editor.value)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
    if (!name) name = t("untitled");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    return `${name}.txt`;
  }

  function saveFlow(saveAs = false, options = {}) {
    const version = documentVersion;
    const pending = saveQueue.then(() => version === documentVersion
      ? performSave(saveAs, options, version) : false);
    saveQueue = pending.catch(() => false);
    return pending;
  }

  async function performSave(saveAs, options, version) {
    const { silent = false } = options;
    let path = S.path;
    let dir = S.dir;

    if (saveAs) {
      const picked = await fileDialog({
        mode: "save",
        startDir: dir || S.settings.lastDir || S.app.notesDir,
        name: isManagedNote() ? defaultSaveName() : S.name,
      });
      if (!picked) return false;
      if (version !== documentVersion) return false;
      path = picked.path;
      dir = picked.dir;
    }

    const savedContent = dom.editor.value;
    const savedEol = S.eol;
    const savedBom = S.bom;
    const result = await call("nSave", {
      path,
      content: savedContent,
      eol: savedEol,
      bom: savedBom,
      expectedMtime: path === S.path ? S.mtime : undefined,
    });
    if (version !== documentVersion) return false;
    if (!result.ok) {
      toast(result.error, "err");
      return false;
    }

    S.recents = result.recents || S.recents;
    S.settings.recents = S.recents;
    S.path = result.file.path;
    S.dir = result.file.dir;
    S.name = result.file.name;
    S.mtime = result.file.mtime;
    S.dirty = dom.editor.value !== savedContent || S.eol !== savedEol || S.bom !== savedBom;
    S.savedAt = Date.now();
    S.settings.lastDir = S.dir;
    if (noteSearchQuery()) scheduleNoteSearch();

    void call("nSettings", { patch: { lastDir: S.dir } });
    renderRecents();
    updateTitle(true);
    updateStatus();
    updateState();
    updateEolBadge();
    scheduleSession(true);
    hideBanner();

    if (silent) flashState(t("autosaved"));
    else toast(t("savedToast", { name: displayName() }));

    return true;
  }

  async function guardUnsaved(action) {
    if (!S.dirty) return true;
    const choice = await ask({
      title: t("unsavedTitle"),
      message: t("unsavedMessage", { name: displayName(), action }),
      buttons: [
        { label: t("cancel"), value: "cancel" },
        { label: t("discard"), value: "discard", kind: "danger" },
        { label: t("save"), value: "save", kind: "primary" },
      ],
    });
    if (choice === "save") return await saveFlow(false) && !S.dirty;
    return choice === "discard";
  }

  async function newDoc() {
    if (!(await guardUnsaved(t("actionNewNote")))) return;
    startBlank(false);
  }

  async function quitFlow() {
    if (!(await guardUnsaved(t("actionQuitting")))) return;
    if (!S.dirty) void call("nSessionClear");
    void call("nQuit");
  }

  /* ------------------------------------------------------------------ */
  /* recovery + autosave                                                */
  /* ------------------------------------------------------------------ */

  let sessionTimer = 0;

  function scheduleSession(immediate) {
    clearTimeout(sessionTimer);
    const write = () => {
      if (dom.editor.value.length > 1500000) {
        void call("nSessionClear");
        return;
      }
      void call("nSession", {
        path: S.path,
        dir: S.dir,
        name: S.name,
        content: dom.editor.value,
        dirty: S.dirty,
        eol: S.eol,
        bom: S.bom,
        mtime: S.mtime,
        at: Date.now(),
      });
    };
    if (immediate) write();
    else sessionTimer = setTimeout(write, 700);
  }

  let autosaveTimer = 0;

  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    if (!S.path || !S.dirty || !S.settings.autosave) return;
    autosaveTimer = setTimeout(() => {
      if (S.path && S.dirty) void saveFlow(false, { silent: true });
    }, S.settings.autosaveDelay || 1600);
  }

  let diskTimer = 0;

  async function checkDisk() {
    if (!S.path || !S.mtime) return;
    const version = documentVersion;
    const path = S.path;
    const result = await call("nStat", { path });
    if (version !== documentVersion) return;
    if (!result.ok || !result.stat.exists) return;
    if (result.stat.mtime === S.mtime) return;

    if (!S.dirty) {
      const reopened = await call("nOpen", { path });
      if (!reopened.ok || version !== documentVersion || S.dirty) return;
      const caret = dom.editor.selectionStart;
      applyOpened(reopened);
      const position = Math.min(caret, dom.editor.value.length);
      dom.editor.setSelectionRange(position, position);
      toast(t("fileChangedReloaded"));
      return;
    }

    showBanner(t("fileChangedBanner"), [
      {
        label: t("reload"),
        run: async () => {
          const reopened = await call("nOpen", { path });
          if (version !== documentVersion) return;
          if (!reopened.ok) {
            toast(reopened.error, "err");
            return;
          }
          applyOpened(reopened);
          hideBanner();
        },
      },
      { label: t("keepMine"), run: () => {
        if (version === documentVersion) S.mtime = result.stat.mtime;
        hideBanner();
      } },
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* recents                                                            */
  /* ------------------------------------------------------------------ */

  let noteSearchResults = [];
  let noteSearchTimer = 0;
  let noteSearchVersion = 0;

  function noteSearchQuery() { return $("note-search").value.trim(); }

  function scheduleNoteSearch(delay = 180) {
    clearTimeout(noteSearchTimer);
    const version = ++noteSearchVersion;
    const query = noteSearchQuery();
    const status = $("note-search-status");
    status.hidden = !query;
    if (!query) {
      noteSearchResults = [];
      renderRecents();
      return;
    }
    status.textContent = t("searching");
    noteSearchTimer = setTimeout(() => void searchSidebarNotes(query, version), delay);
  }

  async function searchSidebarNotes(query, version) {
    const result = await call("nSearchNotes", { query });
    if (version !== noteSearchVersion || query !== noteSearchQuery()) return;
    const status = $("note-search-status");
    if (!result.ok) {
      noteSearchResults = [];
      status.textContent = result.error;
      renderRecents();
      return;
    }
    noteSearchResults = result.results;
    // The disk index cannot see edits that have not been saved yet.
    if (S.path && S.dirty) {
      noteSearchResults = noteSearchResults.filter((entry) => entry.path.toLowerCase() !== S.path.toLowerCase());
      const text = dom.editor.value;
      const needle = query.toLowerCase();
      const name = displayName();
      if (`${name}\n${S.path}\n${text}`.toLowerCase().includes(needle)) {
        const index = Math.max(0, text.toLowerCase().indexOf(needle) - 35);
        noteSearchResults.unshift({ path: S.path, name, dir: S.dir,
          id: S.name.replace(/\.txt$/i, ""), snippet: text.slice(index, index + 140).replace(/\s+/g, " ") });
      }
    }
    status.textContent = `${t("searchResults", { n: noteSearchResults.length })}${result.truncated ? t("searchTruncated") : ""}`;
    renderRecents();
  }

  let draggedRecent = null;
  let recentDropBefore = null;
  let suppressRecentClickUntil = 0;

  function clearRecentDrag() {
    draggedRecent = null;
    recentDropBefore = null;
    document.querySelectorAll(".recent.dragging, .recent.drop-before, .recent.drop-after")
      .forEach((row) => row.classList.remove("dragging", "drop-before", "drop-after"));
  }

  async function finishRecentDrop() {
    if (!draggedRecent) return;
    const path = draggedRecent;
    const beforePath = recentDropBefore;
    suppressRecentClickUntil = Date.now() + 250;
    clearRecentDrag();
    const result = await call("nRecents", { move: true, path, beforePath });
    if (!result.ok) { toast(result.error, "err"); return; }
    S.recents = result.recents;
    S.settings.recents = S.recents;
    renderRecents();
  }

  function sortedRecents(recents) {
    return recents.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  }

  function renderRecents() {
    const box = $("recents");
    box.replaceChildren();
    box.ondragover = (event) => {
      if (!draggedRecent) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.target.closest(".recent")) {
        recentDropBefore = null;
        box.querySelectorAll(".drop-before, .drop-after").forEach((row) => row.classList.remove("drop-before", "drop-after"));
        box.lastElementChild?.classList.add("drop-after");
      }
    };
    box.ondrop = (event) => {
      if (!draggedRecent) return;
      event.preventDefault();
      event.stopPropagation();
      void finishRecentDrop();
    };
    const searching = !!noteSearchQuery();
    const entries = searching ? noteSearchResults : sortedRecents(S.recents);
    if (!entries.length) {
      box.append(el("div", "empty", searching ? t("noMatchingNotes") : t("noRecentFiles")));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const recent of entries) {
      const active = !!S.path && recent.path.toLowerCase() === S.path.toLowerCase();
      const pinned = !searching && recent.pinned === true;
      const button = el("button", `recent${active ? " active" : ""}${pinned ? " pinned" : ""}`);
      button.type = "button";
      button.draggable = !searching;
      button.addEventListener("dragstart", (event) => {
        if (searching) { event.preventDefault(); return; }
        draggedRecent = recent.path;
        recentDropBefore = recent.path;
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", recent.path);
        button.classList.add("dragging");
        closeMenu();
      });
      button.addEventListener("dragover", (event) => {
        if (!draggedRecent) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        box.querySelectorAll(".drop-before, .drop-after").forEach((row) => row.classList.remove("drop-before", "drop-after"));
        const rect = button.getBoundingClientRect();
        const after = event.clientY >= rect.top + rect.height / 2;
        const index = entries.indexOf(recent);
        recentDropBefore = after ? entries[index + 1]?.path || null : recent.path;
        button.classList.add(after ? "drop-after" : "drop-before");
      });
      button.addEventListener("dragend", () => {
        suppressRecentClickUntil = Date.now() + 250;
        clearRecentDrag();
      });
      button.setAttribute("aria-current", active ? "page" : "false");
      button.title = searching ? `${recent.path}\nID: ${recent.id || basenameOf(recent.path)}` : recent.path;
      button.append(el("div", "recent-name", active ? displayName() : recent.name));
      button.append(el("div", "recent-dir", shortDir(recent.dir || recent.path)));
      if (pinned) {
        const badge = el("span", "recent-pin");
        badge.innerHTML = ICONS.pin;
        badge.title = t("pinnedNote");
        button.append(badge);
      }
      if (searching && recent.snippet) button.append(el("div", "recent-snippet", recent.snippet));
      button.addEventListener("click", () => {
        if (draggedRecent || Date.now() < suppressRecentClickUntil) return;
        if (S.path && recent.path.toLowerCase() === S.path.toLowerCase()) {
          focusEditor();
          return;
        }
        void openPath(recent.path);
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openRecentMenu(recent, button, event.clientX, event.clientY);
      });
      fragment.append(button);
    }
    box.append(fragment);
  }

  async function removeRecent(path, silent) {
    const result = await call("nRecents", { remove: true, path });
    if (result.ok) {
      S.recents = result.recents || [];
      S.settings.recents = S.recents;
      renderRecents();
      if (!silent) toast(t("removedFromRecents"));
    }
  }

  async function toggleRecentPin(recent) {
    const pinned = recent.pinned !== true;
    const result = await call("nRecents", { pin: pinned, path: recent.path });
    if (!result.ok) {
      toast(result.error, "err");
      return;
    }
    S.recents = result.recents || [];
    S.settings.recents = S.recents;
    renderRecents();
    toast(t(pinned ? "pinAdded" : "pinRemoved"));
  }

  async function clearRecentFiles() {
    const choice = await ask({
      title: t("clearRecentsTitle"),
      message: t("clearRecentsMessage"),
      buttons: [
        { label: t("cancel"), value: "cancel" },
        { label: t("clear"), value: "clear", kind: "danger" },
      ],
    });
    if (choice !== "clear") return;
    const result = await call("nRecents", { clear: true });
    if (result.ok) {
      S.recents = result.recents || [];
      S.settings.recents = S.recents;
      renderRecents();
      toast(t("recentsCleared"));
    }
  }

  /* ------------------------------------------------------------------ */
  /* banner + toasts                                                    */
  /* ------------------------------------------------------------------ */

  function showBanner(message, actions) {
    dom.bannerText.textContent = message;
    dom.bannerActions.replaceChildren();
    for (const action of actions || []) {
      const button = el("button", "ghost", action.label);
      button.type = "button";
      button.addEventListener("click", () => void action.run());
      dom.bannerActions.append(button);
    }
    dom.banner.hidden = false;
  }

  function hideBanner() {
    dom.banner.hidden = true;
  }

  function toast(message, kind) {
    const node = el("div", `toast${kind === "err" ? " err" : ""}`, String(message));
    dom.toasts.append(node);
    requestAnimationFrame(() => node.classList.add("in"));
    setTimeout(
      () => {
        node.classList.remove("in");
        setTimeout(() => node.remove(), 200);
      },
      kind === "err" ? 6000 : 2600,
    );
    while (dom.toasts.children.length > 4) dom.toasts.firstElementChild.remove();
  }

  /* ------------------------------------------------------------------ */
  /* overlays                                                           */
  /* ------------------------------------------------------------------ */

  function mountOverlay(card, options = {}) {
    const { onClose, variant = "" } = options;
    const layer = el("div", `overlay${variant ? ` ${variant}` : ""}`);
    layer.append(card);
    dom.modals.append(layer);
    const previous = document.activeElement;
    let closed = false;

    const close = (value) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      layer.classList.remove("in");
      S.overlay = null;
      setTimeout(() => layer.remove(), 150);
      if (previous && typeof previous.focus === "function") {
        try {
          previous.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      }
      if (onClose) onClose(value);
    };

    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(null);
      }
    }

    layer.addEventListener("mousedown", (event) => {
      if (event.target === layer) close(null);
    });
    document.addEventListener("keydown", onKey, true);
    requestAnimationFrame(() => layer.classList.add("in"));

    S.overlay = { close, layer };
    return { close, layer };
  }

  function ask(options) {
    const { title = "NISIO Note", message = "", buttons = [] } = options || {};
    return new Promise((resolve) => {
      const card = el("div", "card ask");
      card.append(el("div", "dlg-title", title));
      card.append(el("div", "ask-msg", message));
      const row = el("div", "ask-actions");
      let control = null;

      for (const button of buttons) {
        const node = el(
          "button",
          button.kind === "primary" ? "primary" : button.kind === "danger" ? "danger" : "ghost",
          button.label,
        );
        node.type = "button";
        node.addEventListener("click", () => control && control.close(button.value));
        row.append(node);
      }

      card.append(row);
      control = mountOverlay(card, { onClose: resolve });
      requestAnimationFrame(() => {
        const first = row.querySelector(".primary") || row.querySelector("button");
        if (first) first.focus();
      });
    });
  }

  function promptText(options) {
    const { title = "NISIO Note", label = "", value = "", placeholder = "" } = options || {};
    return new Promise((resolve) => {
      const card = el("div", "card prompt");
      card.append(el("div", "dlg-title", title));
      card.append(el("label", "prompt-label", label));
      const input = el("input", "field prompt-input");
      input.type = "text";
      input.value = value;
      input.placeholder = placeholder;
      input.spellcheck = false;
      const actions = el("div", "prompt-actions");
      const cancel = el("button", "ghost", t("cancel"));
      cancel.type = "button";
      const ok = el("button", "primary", t("ok"));
      ok.type = "button";
      actions.append(cancel, ok);
      card.append(input, actions);

      let control = null;
      const submit = () => control && control.close(input.value.trim());
      cancel.addEventListener("click", () => control && control.close(null));
      ok.addEventListener("click", submit);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      });

      control = mountOverlay(card, { onClose: resolve });
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    });
  }

  function infoModal(title, html) {
    return new Promise((resolve) => {
      const card = el("div", "card info");
      card.append(el("div", "info-head", title));
      const body = el("div", "info-body");
      body.innerHTML = html;
      card.append(body);
      const foot = el("div", "info-foot");
      const close = el("button", "primary", t("close"));
      close.type = "button";
      foot.append(close);
      card.append(foot);

      const control = mountOverlay(card, { onClose: resolve });
      close.addEventListener("click", () => control.close(null));
      close.focus();
    });
  }

  /* ------------------------------------------------------------------ */
  /* markdown preview                                                   */
  /* ------------------------------------------------------------------ */

  function inlineMarkdown(source) {
    let text = escapeHtml(source);
    text = text.replace(/!\[([^\]]*)\]\((nisio-asset:[0-9a-f-]{36}\.png)\)/gi, (_match, alt, url) => {
      const id = url.slice("nisio-asset:".length);
      const cached = S.imageCache.get(id);
      return `<img class="note-image" alt="${alt}" data-asset="${id}"${cached ? ` src="${cached}"` : ""} />`;
    });
    text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" rel="noreferrer">[image] $1</a>');
    text = text.replace(/`([^`]+)`/g, (_match, code) => `<code>${code}</code>`);
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    text = text.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
    text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    text = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" rel="noreferrer">$1</a>',
    );
    return text;
  }

  function renderMarkdown(source) {
    const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let index = 0;
    let listKind = null;
    let paragraph = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    };
    const closeList = () => {
      if (!listKind) return;
      out.push(`</${listKind}>`);
      listKind = null;
    };

    while (index < lines.length) {
      const line = lines[index];
      const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
      if (fence) {
        flushParagraph();
        closeList();
        const code = [];
        index++;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          code.push(lines[index]);
          index++;
        }
        index++;
        const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
        out.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        closeList();
        index++;
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        closeList();
        const level = heading[1].length;
        out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        index++;
        continue;
      }

      if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
        flushParagraph();
        closeList();
        out.push("<hr />");
        index++;
        continue;
      }

      const quote = /^>\s?(.*)$/.exec(line);
      if (quote) {
        flushParagraph();
        closeList();
        const quoted = [quote[1]];
        index++;
        while (index < lines.length && /^>\s?/.test(lines[index])) {
          quoted.push(lines[index].replace(/^>\s?/, ""));
          index++;
        }
        out.push(`<blockquote>${inlineMarkdown(quoted.join(" "))}</blockquote>`);
        continue;
      }

      const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (unordered || ordered) {
        flushParagraph();
        const kind = unordered ? "ul" : "ol";
        if (listKind !== kind) {
          closeList();
          out.push(`<${kind}>`);
          listKind = kind;
        }
        const body = unordered ? unordered[1] : ordered[1];
        const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
        if (task) {
          const checked = task[1].toLowerCase() === "x";
          out.push(
            `<li class="task"><span class="box${checked ? " checked" : ""}"></span>${inlineMarkdown(task[2])}</li>`,
          );
        } else {
          out.push(`<li>${inlineMarkdown(body)}</li>`);
        }
        index++;
        continue;
      }

      flushParagraph();
      paragraph.push(line.trim());
      index++;
    }

    flushParagraph();
    closeList();
    return out.join("\n");
  }

  let previewTimer = 0;
  let previewSource = null;

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 150);
  }

  function renderPreview() {
    if (!S.settings.preview) {
      previewSource = null;
      return;
    }
    const source = `${S.settings.lang}\u0000${dom.editor.value}`;
    if (source === previewSource) return;
    previewSource = source;
    const ratio =
      dom.preview.scrollHeight > dom.preview.clientHeight
        ? dom.preview.scrollTop / (dom.preview.scrollHeight - dom.preview.clientHeight)
        : 0;
    const value = dom.editor.value;
    dom.preview.innerHTML = value.trim()
      ? renderMarkdown(value)
      : `<div class="preview-empty">${escapeHtml(t("nothingToPreview"))}</div>`;
    void hydratePreviewImages();
    const scrollable = dom.preview.scrollHeight - dom.preview.clientHeight;
    if (scrollable > 0) dom.preview.scrollTop = ratio * scrollable;
  }

  let imageCacheBytes = 0;
  const IMAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;

  function cacheImage(id, dataUrl) {
    const existing = S.imageCache.get(id);
    if (existing) {
      imageCacheBytes -= existing.length;
      S.imageCache.delete(id);
    }
    S.imageCache.set(id, dataUrl);
    imageCacheBytes += dataUrl.length;
    while (S.imageCache.size > 32 || imageCacheBytes > IMAGE_CACHE_MAX_BYTES) {
      const oldest = S.imageCache.keys().next().value;
      if (oldest === undefined) break;
      const oldData = S.imageCache.get(oldest);
      imageCacheBytes -= oldData ? oldData.length : 0;
      S.imageCache.delete(oldest);
    }
  }

  async function hydratePreviewImages() {
    const pending = Array.from(dom.preview.querySelectorAll("img[data-asset]"));
    for (const image of pending) {
      const id = image.dataset.asset;
      if (!id) continue;
      let dataUrl = S.imageCache.get(id);
      if (!dataUrl) {
        const result = await call("nImageRead", { id });
        if (!image.isConnected) continue;
        if (!result.ok) {
          image.replaceWith(el("span", "missing-image", t("missingImage", { id })));
          continue;
        }
        dataUrl = result.dataUrl;
        cacheImage(id, dataUrl);
      }
      if (image.isConnected) image.src = dataUrl;
    }
  }

  dom.preview.addEventListener("click", (event) => {
    const anchor = event.target.closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) void call("nExternal", { url: href });
  });

  /* ------------------------------------------------------------------ */
  /* file dialog                                                        */
  /* ------------------------------------------------------------------ */

  function iconKind(entry) {
    if (entry.dir) return "dir";
    const ext = entry.ext || "";
    if (["md", "markdown", "mdown", "mkd"].includes(ext)) return "md";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return "img";
    if (
      [
        "js",
        "ts",
        "tsx",
        "jsx",
        "json",
        "html",
        "css",
        "scss",
        "py",
        "rs",
        "go",
        "c",
        "h",
        "cpp",
        "java",
        "sh",
        "bat",
        "ps1",
        "yml",
        "yaml",
        "toml",
        "xml",
        "sql",
      ].includes(ext)
    ) {
      return "code";
    }
    return "";
  }

  function glyphFor(kind) {
    if (kind === "md") return "◈";
    if (kind === "img") return "▣";
    if (kind === "code") return "❮❯";
    return "·";
  }

  function fileDialog(options) {
    if (S.app?.platform === "win32") {
      return call("nFileDialog", options || { mode: "open" }).then((result) => {
        if (!result.ok) { toast(result.error, "err"); return null; }
        if (!result.path) return null;
        S.settings.lastDir = result.dir;
        return { path: result.path, dir: result.dir };
      });
    }
    const { mode = "open", startDir = null, name = "" } = options || {};
    return new Promise((resolve) => {
      const state = {
        dir: null,
        parent: null,
        crumbs: [],
        entries: [],
        sel: -1,
        filter: "",
        filename: name || "",
        pendingPath: null,
        loading: false,
      };

      const card = el("div", "card filedlg");
      card.innerHTML = `
        <div class="dlg-head">
          <div class="dlg-title"></div>
          <button class="icon dlg-x" title="${escapeHtml(t("close"))}">✕</button>
        </div>
        <div class="dlg-crumbs"></div>
        <div class="dlg-body">
          <div class="dlg-places"></div>
          <div class="dlg-main">
            <div class="dlg-toolrow">
              <input class="field dlg-filter" placeholder="${escapeHtml(t("filterFolder"))}" spellcheck="false" />
              <button class="ghost dlg-newfolder" type="button">${escapeHtml(t("newFolder"))}</button>
            </div>
            <div class="dlg-newrow" hidden>
              <input class="field dlg-newname" placeholder="${escapeHtml(t("newFolderName"))}" spellcheck="false" />
              <button class="ghost dlg-create" type="button">${escapeHtml(t("create"))}</button>
            </div>
            <div class="dlg-list" tabindex="0"></div>
          </div>
        </div>
        <div class="dlg-foot">
          <div class="dlg-path"></div>
          <input class="field dlg-name" placeholder="${escapeHtml(t("fileName"))}" spellcheck="false" />
          <button class="ghost dlg-cancel" type="button">${escapeHtml(t("cancel"))}</button>
          <button class="primary dlg-ok" type="button">${escapeHtml(t("open"))}</button>
        </div>`;

      const title = card.querySelector(".dlg-title");
      const crumbsBox = card.querySelector(".dlg-crumbs");
      const placesBox = card.querySelector(".dlg-places");
      const filterInput = card.querySelector(".dlg-filter");
      const list = card.querySelector(".dlg-list");
      const nameInput = card.querySelector(".dlg-name");
      const pathLabel = card.querySelector(".dlg-path");
      const okButton = card.querySelector(".dlg-ok");
      const newFolderButton = card.querySelector(".dlg-newfolder");
      const newRow = card.querySelector(".dlg-newrow");
      const newName = card.querySelector(".dlg-newname");
      const createButton = card.querySelector(".dlg-create");

      let control = null;

      const finish = (path) => control.close({ path, dir: state.dir });

      const rows = () => Array.from(list.querySelectorAll(".frow"));

      function visibleEntries() {
        const query = state.filter.trim().toLowerCase();
        if (!query) return state.entries;
        return state.entries.filter((entry) => entry.name.toLowerCase().includes(query));
      }

      function resetPending() {
        state.pendingPath = null;
        okButton.textContent = mode === "save" ? t("save") : t("open");
      }

      function setSelection(index, scroll) {
        state.sel = index;
        resetPending();
        rows().forEach((row, rowIndex) => {
          row.classList.toggle("sel", rowIndex === index);
        });
        if (scroll) {
          const row = rows()[index];
          if (row) row.scrollIntoView({ block: "nearest" });
        }
      }

      function renderList() {
        const entries = visibleEntries();
        list.replaceChildren();
        if (state.loading) {
          list.append(el("div", "dlg-empty", t("loading")));
          return;
        }
        if (!entries.length) {
          list.append(
            el(
              "div",
              "dlg-empty",
              state.filter ? t("nothingMatchesFilter") : t("folderEmpty"),
            ),
          );
          return;
        }
        entries.forEach((entry, index) => {
          const kind = iconKind(entry);
          const row = el("div", `frow${index === state.sel ? " sel" : ""}`);
          row.append(el("span", `ficon ${kind}`, entry.dir ? "▸" : glyphFor(kind)));
          row.append(el("span", "fname", entry.name));
          row.append(el("span", "fmeta", entry.dir ? "" : fmtSize(entry.size)));
          row.addEventListener("click", () => setSelection(index, false));
          row.addEventListener("dblclick", () => void activate(entry, index));
          list.append(row);
        });
      }

      function renderChrome() {
        title.textContent = mode === "save" ? t("saveAsTitle") : t("openDialogTitle");
        crumbsBox.replaceChildren();

        if (state.parent) {
          const up = el("button", "crumb", "↑");
          up.type = "button";
          up.title = t("parentFolder");
          up.addEventListener("click", () => void loadDir(state.parent));
          crumbsBox.append(up);
        }
        state.crumbs.forEach((crumb, index) => {
          if (index > 0) crumbsBox.append(el("span", "crumb-sep", "›"));
          const button = el(
            "button",
            `crumb${index === state.crumbs.length - 1 ? " last" : ""}`,
            crumb.label,
          );
          button.type = "button";
          button.title = crumb.path;
          button.addEventListener("click", () => void loadDir(crumb.path));
          crumbsBox.append(button);
        });

        placesBox.replaceChildren();
        for (const place of S.places) {
          const button = el("button", "place");
          button.type = "button";
          button.append(el("span", "pico", "◆"));
          button.append(el("span", "pname", place.label));
          button.title = place.path;
          button.addEventListener("click", () => void loadDir(place.path));
          placesBox.append(button);
        }

        pathLabel.textContent = state.dir || "";
        pathLabel.title = state.dir || "";
        nameInput.hidden = mode !== "save";
        newFolderButton.hidden = mode !== "save";
        if (mode === "save") nameInput.value = state.filename;
        okButton.textContent = state.pendingPath ? t("overwrite") : mode === "save" ? t("save") : t("open");
      }

      async function loadDir(target) {
        state.loading = true;
        state.filter = "";
        filterInput.value = "";
        renderList();
        const result = await call("nListDir", { path: target || "" });
        state.loading = false;
        if (!result.ok) {
          toast(result.error, "err");
          renderList();
          return;
        }
        const listing = result.listing;
        state.dir = listing.path;
        state.parent = listing.parent;
        state.crumbs = listing.crumbs;
        state.entries = listing.entries;
        state.sel = listing.entries.length ? 0 : -1;
        resetPending();
        S.settings.lastDir = state.dir;
        void call("nSettings", { patch: { lastDir: state.dir } });
        renderChrome();
        renderList();
        list.scrollTop = 0;
        if (mode === "open") list.focus();
      }

      async function activate(entry, index) {
        if (typeof index === "number") setSelection(index, false);
        if (entry.dir) {
          await loadDir(entry.path);
          return;
        }
        if (mode === "save") {
          state.filename = entry.name;
          nameInput.value = entry.name;
          nameInput.focus();
          nameInput.select();
          resetPending();
          return;
        }
        finish(entry.path);
      }

      async function confirmSelection() {
        if (mode === "open") {
          const entries = visibleEntries();
          const entry = state.sel >= 0 ? entries[state.sel] : null;
          if (!entry) {
            toast(t("selectFileFirst"), "err");
            return;
          }
          if (entry.dir) {
            await loadDir(entry.path);
            return;
          }
          finish(entry.path);
          return;
        }

        const value = nameInput.value.trim();
        if (!value) {
          toast(t("enterFileName"), "err");
          nameInput.focus();
          return;
        }
        if (!isAbsoluteish(value) && /[\\/:*?"<>|]/.test(value)) {
          toast(t("invalidFileName"), "err");
          return;
        }
        const path = isAbsoluteish(value) ? value : joinPath(state.dir, value);
        const info = await call("nStat", { path });
        if (info.ok && info.stat.exists && state.pendingPath !== path) {
          state.pendingPath = path;
          okButton.textContent = t("overwrite");
          return;
        }
        finish(path);
      }

      card.addEventListener("keydown", (event) => {
        if (event.key === "Escape") return;
        if (event.target === nameInput) {
          if (event.key === "Enter") {
            event.preventDefault();
            void confirmSelection();
          }
          return;
        }
        if (event.target === newName) {
          if (event.key === "Enter") {
            event.preventDefault();
            void createFolder();
          }
          return;
        }
        if (event.target === filterInput) {
          if (event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            list.focus();
            if (state.sel < 0) setSelection(0, true);
          }
          return;
        }

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const entries = visibleEntries();
          if (!entries.length) return;
          const direction = event.key === "ArrowDown" ? 1 : -1;
          let next = state.sel < 0 ? (direction > 0 ? 0 : entries.length - 1) : state.sel + direction;
          next = clamp(next, 0, entries.length - 1);
          setSelection(next, true);
        } else if (event.key === "Enter") {
          event.preventDefault();
          void confirmSelection();
        } else if (event.key === "Backspace" && !filterInput.value && state.parent) {
          event.preventDefault();
          void loadDir(state.parent);
        }
      });

      async function createFolder() {
        const value = newName.value.trim();
        if (!value) {
          newName.focus();
          return;
        }
        const result = await call("nMkdir", { parent: state.dir, name: value });
        if (!result.ok) {
          toast(result.error, "err");
          return;
        }
        newName.value = "";
        newRow.hidden = true;
        await loadDir(state.dir);
        const index = visibleEntries().findIndex((entry) => entry.path === result.path);
        if (index >= 0) setSelection(index, true);
        toast(t("createdFolder", { name: value }));
      }

      card.querySelector(".dlg-x").addEventListener("click", () => control.close(null));
      card.querySelector(".dlg-cancel").addEventListener("click", () => control.close(null));
      okButton.addEventListener("click", () => void confirmSelection());
      filterInput.addEventListener("input", () => {
        state.filter = filterInput.value;
        state.sel = visibleEntries().length ? 0 : -1;
        renderList();
      });
      newFolderButton.addEventListener("click", () => {
        newRow.hidden = false;
        newName.focus();
      });
      createButton.addEventListener("click", () => void createFolder());
      nameInput.addEventListener("input", () => {
        state.filename = nameInput.value;
        resetPending();
      });

      control = mountOverlay(card, { onClose: resolve });
      void loadDir(startDir);

      requestAnimationFrame(() => {
        if (mode === "save") {
          nameInput.focus();
          const dot = state.filename.lastIndexOf(".");
          if (dot > 0) nameInput.setSelectionRange(0, dot);
          else nameInput.select();
        } else {
          list.focus();
        }
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* command palette                                                    */
  /* ------------------------------------------------------------------ */

  function openPalette(mode) {
    const card = el("div", "card palette");
    card.innerHTML = `
      <input class="palette-input" placeholder="${escapeHtml(t("palettePlaceholder"))}" spellcheck="false" />
      <div class="palette-list"></div>
      <div class="palette-foot"><span>${escapeHtml(t("paletteMove"))}</span><span>${escapeHtml(t("paletteRun"))}</span><span>${escapeHtml(t("paletteClose"))}</span></div>`;
    const input = card.querySelector(".palette-input");
    const list = card.querySelector(".palette-list");

    const commands = COMMANDS.filter((command) => !command.disabled || !command.disabled());
    const items = [];
    const addCommands = () =>
      commands.forEach((command) =>
        items.push({
          icon: "›",
          label: t(command.labelKey),
          hint: command.hint || "",
          run: command.run,
        }),
      );
    const addRecents = () =>
      sortedRecents(S.recents).forEach((recent) =>
        items.push({
          icon: "≡",
          label: `${recent.pinned ? `${t("pinnedNote")} · ` : ""}${recent.name}`,
          hint: shortDir(recent.dir || ""),
          run: () => void openPath(recent.path),
        }),
      );

    if (mode === "open") {
      addRecents();
      addCommands();
    } else {
      addCommands();
      addRecents();
    }

    let shown = items.slice();
    let index = 0;
    let control = null;

    function select(next) {
      if (next === index) return;
      const rows = list.children;
      rows[index]?.classList.remove("sel");
      index = next;
      const row = rows[index];
      if (row) {
        row.classList.add("sel");
        row.scrollIntoView({ block: "nearest" });
      }
    }

    function render() {
      list.replaceChildren();
      if (!shown.length) {
        list.append(el("div", "dlg-empty", t("noMatches")));
        return;
      }
      const fragment = document.createDocumentFragment();
      shown.forEach((item, itemIndex) => {
        const row = el("div", `pitem${itemIndex === index ? " sel" : ""}`);
        row.append(el("span", "pico", item.icon));
        row.append(el("span", "plabel", item.label));
        if (item.hint) row.append(el("span", "phint", item.hint));
        row.addEventListener("mousemove", () => select(itemIndex));
        row.addEventListener("click", () => run(item));
        fragment.append(row);
      });
      list.append(fragment);
      const current = list.children[index];
      if (current) current.scrollIntoView({ block: "nearest" });
    }

    function filter() {
      const query = input.value.trim().toLowerCase();
      shown = !query
        ? items.slice()
        : items.filter((item) =>
            fuzzyMatch(query, `${item.label} ${item.hint}`.toLowerCase()),
          );
      index = 0;
      render();
    }

    function run(item) {
      if (!item) return;
      control.close(null);
      setTimeout(() => item.run(), 20);
    }

    input.addEventListener("input", filter);
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!shown.length) return;
        const direction = event.key === "ArrowDown" ? 1 : -1;
        select((index + direction + shown.length) % shown.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        run(shown[index]);
      }
    });

    control = mountOverlay(card, { variant: "top", onClose: () => {} });
    render();
    requestAnimationFrame(() => input.focus());
  }

  /* ------------------------------------------------------------------ */
  /* find / replace                                                     */
  /* ------------------------------------------------------------------ */

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildPattern() {
    const query = dom.findInput.value;
    if (!query) return null;
    const caseSensitive = $("find-case").classList.contains("on");
    const isRegex = $("find-regex").classList.contains("on");
    const flags = `g${caseSensitive ? "" : "i"}`;
    try {
      return new RegExp(isRegex ? query : escapeRegExp(query), flags);
    } catch {
      return null;
    }
  }

  let findSource = null;
  let findKey = "";

  function refreshMatches() {
    const pattern = buildPattern();
    const key = pattern ? `${pattern.source}/${pattern.flags}` : "";
    const text = dom.editor.value;
    if (key === findKey && text === findSource) return;
    findKey = key;
    findSource = text;
    S.find.matches = [];
    if (!pattern) {
      dom.findCount.textContent = "0/0";
      return;
    }
    let match;
    let guard = 0;
    while ((match = pattern.exec(text)) !== null && guard++ < 20000) {
      if (match[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      S.find.matches.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  function updateFindCount() {
    const total = S.find.matches.length;
    if (!total) {
      dom.findCount.textContent = "0/0";
      return;
    }
    const caret = dom.editor.selectionStart;
    const current = S.find.matches.findIndex(
      (match) => match.start === dom.editor.selectionStart && match.end === dom.editor.selectionEnd,
    );
    const near = S.find.matches.findIndex((match) => match.start >= caret);
    dom.findCount.textContent = `${current >= 0 ? current + 1 : near >= 0 ? near + 1 : 1}/${total}`;
  }

  function selectRange(start, end, takeFocus) {
    if (takeFocus) dom.editor.focus({ preventScroll: true });
    dom.editor.revealRange(start, end);
    updateStatus();
  }

  function findStep(direction) {
    if (dom.findbar.hidden) {
      openFind("find");
      return;
    }
    refreshMatches();
    const total = S.find.matches.length;
    if (!total) {
      updateFindCount();
      return;
    }
    const caret = dom.editor.selectionStart;
    const caretEnd = dom.editor.selectionEnd;
    let index = S.find.matches.findIndex(
      (match) => match.start === caret && match.end === caretEnd,
    );
    if (index < 0) {
      if (direction > 0) {
        index = S.find.matches.findIndex((match) => match.start >= caretEnd);
        if (index < 0) index = 0;
      } else {
        index = -1;
        for (let i = total - 1; i >= 0; i--) {
          if (S.find.matches[i].end <= caret) {
            index = i;
            break;
          }
        }
        if (index < 0) index = total - 1;
      }
    } else index = (index + direction + total) % total;
    const match = S.find.matches[index];
    selectRange(match.start, match.end);
    updateFindCount();
  }

  function findFromCaret() {
    refreshMatches();
    if (!S.find.matches.length) {
      updateFindCount();
      return;
    }
    const caret = dom.editor.selectionStart;
    let index = S.find.matches.findIndex((match) => match.start >= caret);
    if (index < 0) index = 0;
    const match = S.find.matches[index];
    selectRange(match.start, match.end);
    updateFindCount();
  }

  function openFind(mode) {
    dom.findbar.hidden = false;
    dom.replaceRow.hidden = mode !== "replace";
    const selected = dom.editor.value.slice(dom.editor.selectionStart, dom.editor.selectionEnd);
    if (selected && !selected.includes("\n") && selected.length < 200) {
      dom.findInput.value = selected;
    }
    requestAnimationFrame(() => {
      dom.findInput.focus();
      dom.findInput.select();
    });
    findFromCaret();
  }

  function closeFind() {
    dom.findbar.hidden = true;
    S.find.matches = [];
    findSource = null;
    findKey = "";
    focusEditor();
  }

  function replaceOne() {
    refreshMatches();
    let index = S.find.matches.findIndex(
      (match) =>
        match.start === dom.editor.selectionStart && match.end === dom.editor.selectionEnd,
    );
    if (index < 0) {
      findStep(1);
      return;
    }
    const match = S.find.matches[index];
    const replacement = dom.replaceInput.value;
    selectRange(match.start, match.end);
    insertText(replacement);
    findFromCaret();
  }

  function replaceAll() {
    const pattern = buildPattern();
    if (!pattern) {
      toast(t("invalidPattern"), "err");
      return;
    }
    refreshMatches();
    const total = S.find.matches.length;
    if (!total) {
      toast(t("noMatchesReplace"));
      return;
    }
    const text = dom.editor.value;
    const replacement = dom.replaceInput.value;
    const isRegex = $("find-regex").classList.contains("on");
    const next = isRegex ? text.replace(pattern, replacement) : text.replace(pattern, () => replacement);
    dom.editor.focus({ preventScroll: true });
    dom.editor.select();
    insertText(next);
    findFromCaret();
    toast(t(total === 1 ? "replacedOne" : "replacedMany", { n: fmtNum(total) }));
  }

  /* ------------------------------------------------------------------ */
  /* editing helpers                                                    */
  /* ------------------------------------------------------------------ */

  function insertText(text) {
    dom.editor.focus({ preventScroll: true });
    dom.editor.setRangeText(text, dom.editor.selectionStart, dom.editor.selectionEnd, "end");
  }

  async function copyEditorSelection(cut) {
    const version = documentVersion;
    const start = dom.editor.selectionStart, end = dom.editor.selectionEnd;
    const original = dom.editor.value;
    const result = await call("nClipboardWrite", { text: original.slice(start, end) });
    if (!result.ok) { toast(result.error, "err"); return; }
    if (cut && version === documentVersion && dom.editor.value === original) {
      dom.editor.setRangeText("", start, end, "end");
    }
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  async function imageFileToPngBase64(file) {
    if (!file || !file.type.startsWith("image/")) throw new Error(t("notImage"));
    if (file.size > 25 * 1024 * 1024) throw new Error(t("imageTooLarge"));
    if (file.type === "image/png") {
      return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    }
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error(t("imageConvertFail"));
      context.drawImage(bitmap, 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      return dataUrl.slice(dataUrl.indexOf(",") + 1);
    } finally {
      bitmap.close?.();
    }
  }

  async function insertImageAttachment(file) {
    const base64 = await imageFileToPngBase64(file);
    const result = await call("nImageSave", { base64 });
    if (!result.ok) throw new Error(result.error);
    cacheImage(result.id, `data:image/png;base64,${base64}`);
    const value = dom.editor.value;
    const position = dom.editor.selectionStart;
    const leading = position > 0 && value[position - 1] !== "\n" ? "\n" : "";
    const trailing = value[position] && value[position] !== "\n" ? "\n" : "";
    insertText(`${leading}![image](${result.url})${trailing}`);
    if (S.settings.preview) renderPreview();
    toast(t("imageInserted"));
  }

  async function pasteClipboardImage() {
    const result = await call("nImagePaste");
    if (!result.ok) {
      toast(result.noImage ? t("noClipboardImage") : result.error, result.noImage ? undefined : "err");
      return;
    }
    const value = dom.editor.value;
    const position = dom.editor.selectionStart;
    const leading = position > 0 && value[position - 1] !== "\n" ? "\n" : "";
    const trailing = value[position] && value[position] !== "\n" ? "\n" : "";
    insertText(`${leading}![image](${result.url})${trailing}`);
    if (S.settings.preview) renderPreview();
    toast(t("imagePasted"));
  }

  function indentUnit() {
    return S.settings.softTabs ? " ".repeat(S.settings.tabSize || 2) : "\t";
  }

  function selectedLineRange() {
    const value = dom.editor.value;
    const start = value.lastIndexOf("\n", dom.editor.selectionStart - 1) + 1;
    let end = value.indexOf("\n", dom.editor.selectionEnd);
    if (end === -1) end = value.length;
    return [start, end];
  }

  function indentSelection(outdent) {
    const [start, end] = selectedLineRange();
    const block = dom.editor.value.slice(start, end);
    const unit = indentUnit();
    const next = block
      .split("\n")
      .map((line) => {
        if (!outdent) return unit + line;
        if (line.startsWith("\t")) return line.slice(1);
        let strip = 0;
        while (strip < unit.length && line[strip] === " ") strip++;
        return line.slice(strip);
      })
      .join("\n");
    if (next === block) return;
    dom.editor.setRangeText(next, start, end, "select");
    dom.editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function handleEnter(event) {
    if (S.settings.autoIndent === false) return;
    const value = dom.editor.value;
    const start = dom.editor.selectionStart;
    const end = dom.editor.selectionEnd;
    if (start !== end) return;

    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const prefix = value.slice(lineStart, start);
    const indent = /^[ \t]*/.exec(prefix)[0];
    const unit = indentUnit();
    const opens = /[{\[(:]\s*$/.test(prefix);
    const closer = value[start] || "";
    const paired = opens && /[)\]}]/.test(closer);

    event.preventDefault();
    if (paired) {
      const extra = opens ? unit : "";
      insertText(`\n${indent}${extra}\n${indent}`);
      const caret = start + 1 + indent.length + extra.length;
      dom.editor.setSelectionRange(caret, caret);
      updateStatus();
    } else {
      insertText(`\n${indent}${opens ? unit : ""}`);
    }
  }

  function onEditorInput() {
    S.dirty = true;
    updateSaveButton();
    lineIndexDirty = true;
    scheduleEditorMetrics(true);
    scheduleCounts();
    scheduleSession();
    scheduleAutosave();
    if (noteSearchQuery()) scheduleNoteSearch(400);
    if (S.settings.preview) schedulePreview();
  }

  /* ------------------------------------------------------------------ */
  /* commands + menus                                                   */
  /* ------------------------------------------------------------------ */

  function persistSettings(patch) {
    Object.assign(S.settings, patch);
    void call("nSettings", { patch });
  }

  function cycleTheme() {
    const order = ["auto", "dark", "light"];
    const next = order[(order.indexOf(S.settings.theme) + 1) % order.length];
    persistSettings({ theme: next });
    applyTheme();
    toast(t("themeToast", { theme: themeLabel(next) }));
  }

  let fontPanel = null;
  let fontListLoaded = false;
  let fontListLoading = false;

  function syncFontPanel() {
    if (!fontPanel) return;
    const active = document.activeElement;
    const set = (id, value) => {
      const input = $(id);
      if (active !== input) input.value = value;
    };
    set("font-family", S.settings.fontFamily || "");
    set("font-size", S.settings.fontSize);
    set("font-weight", S.settings.fontWeight || 400);
    set("font-height", S.settings.lineHeight || 1.62);
  }

  async function toggleFontPanel() {
    if (!fontPanel) {
      fontPanel = el("section", "fontbar");
      fontPanel.setAttribute("aria-label", t("fontSettings"));
      fontPanel.innerHTML = `
        <div class="fontbar-head"><strong>${escapeHtml(t("fontSettings"))}</strong>
          <span id="font-list-status" role="status">${escapeHtml(t("installedFonts"))}</span>
          <button id="font-reset" class="ghost" type="button">${escapeHtml(t("reset"))}</button>
          <button id="font-close" class="icon" aria-label="${escapeHtml(t("closeFontSettings"))}" title="${escapeHtml(t("close"))}">×</button>
        </div>
        <div class="fontbar-fields">
          <label class="font-family-label">${escapeHtml(t("fontFamily"))}
            <input id="font-family" class="field" list="installed-fonts" placeholder="${escapeHtml(t("fontPlaceholder"))}" spellcheck="false" autocomplete="off" />
            <datalist id="installed-fonts"></datalist>
          </label>
          <label>${escapeHtml(t("size"))} <input id="font-size" class="field" type="number" min="10" max="32" step="1" /></label>
          <label>${escapeHtml(t("weight"))} <select id="font-weight" class="field">
            <option value="100">${escapeHtml(t("weightThin"))}</option><option value="200">${escapeHtml(t("weightExtraLight"))}</option>
            <option value="300">${escapeHtml(t("weightLight"))}</option><option value="400">${escapeHtml(t("weightRegular"))}</option>
            <option value="500">${escapeHtml(t("weightMedium"))}</option><option value="600">${escapeHtml(t("weightSemibold"))}</option>
            <option value="700">${escapeHtml(t("weightBold"))}</option><option value="800">${escapeHtml(t("weightExtraBold"))}</option>
            <option value="900">${escapeHtml(t("weightBlack"))}</option>
          </select></label>
          <label>${escapeHtml(t("lineSpacing"))} <input id="font-height" class="field" type="number" min="1.1" max="2.5" step="0.05" /></label>
        </div>`;
      dom.findbar.before(fontPanel);
      const update = () => {
        const patch = { fontFamily: $("font-family").value.trim().slice(0, 200) };
        if ($("font-size").value) patch.fontSize = clamp(Number($("font-size").value) || 15, 10, 32);
        if ($("font-height").value) patch.lineHeight = clamp(Number($("font-height").value) || 1.62, 1.1, 2.5);
        patch.fontWeight = Number($("font-weight").value) || 400;
        persistSettings(patch);
        applyFont();
      };
      fontPanel.querySelectorAll("input, select").forEach((input) => {
        input.addEventListener("change", update);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); update(); }
          if (event.key === "Escape") { fontPanel.hidden = true; focusEditor(); }
        });
      });
      $("font-reset").addEventListener("click", () => {
        persistSettings({ fontFamily: "", fontSize: 15, fontWeight: 400, lineHeight: 1.62 });
        applyFont();
      });
      $("font-close").addEventListener("click", () => { fontPanel.hidden = true; focusEditor(); });
    } else {
      fontPanel.hidden = !fontPanel.hidden;
    }
    if (fontPanel.hidden) return;
    syncFontPanel();
    $("font-family").focus();
    if (fontListLoaded || fontListLoading) return;
    fontListLoading = true;
    $("font-list-status").textContent = t("readingFonts");
    const result = await call("nFonts");
    fontListLoading = false;
    if (!result.ok) {
      $("font-list-status").textContent = t("enterFontManually");
      toast(result.error, "err");
      return;
    }
    const list = $("installed-fonts");
    list.replaceChildren();
    for (const name of result.fonts) {
      const option = el("option");
      option.value = name;
      list.append(option);
    }
    fontListLoaded = true;
    $("font-list-status").textContent = t("fontsFound", { n: result.fonts.length });
  }

  const SETTINGS_GROUPS = [
    { id: "appearance", labelKey: "groupAppearance", descriptionKey: "groupAppearanceDesc", items: [
      { key: "lang", labelKey: "setLanguage", helpKey: "setLanguageHelp", options: [["en", "langEnglish"], ["th", "langThai"]] },
      { key: "theme", labelKey: "setTheme", helpKey: "setThemeHelp", options: [["auto", "optSystem"], ["light", "optLight"], ["dark", "optDark"]] },
      { key: "fontFamily", labelKey: "setFontFamily", helpKey: "setFontFamilyHelp", type: "font" },
      { key: "fontSize", labelKey: "setFontSize", helpKey: "setFontSizeHelp", type: "number", min: 10, max: 32, step: 1 },
      { key: "fontWeight", labelKey: "setFontWeight", helpKey: "setFontWeightHelp", numeric: true, options: [[300, "weightLight"], [400, "weightRegular"], [500, "weightMedium"], [600, "weightSemibold"], [700, "weightBold"], [800, "weightExtraBold"], [900, "weightBlack"]] },
      { key: "lineHeight", labelKey: "setLineHeight", helpKey: "setLineHeightHelp", type: "number", min: 1.1, max: 2.5, step: 0.05 },
      { key: "sidebar", labelKey: "setSidebar", helpKey: "setSidebarHelp", type: "checkbox" },
      { key: "lineNumbers", labelKey: "setLineNumbers", helpKey: "setLineNumbersHelp", type: "checkbox" },
    ] },
    { id: "editor", labelKey: "groupEditor", descriptionKey: "groupEditorDesc", items: [
      { key: "wrap", labelKey: "setWrap", helpKey: "setWrapHelp", type: "checkbox" },
      { key: "spellcheck", labelKey: "setSpellcheck", helpKey: "setSpellcheckHelp", type: "checkbox" },
      { key: "autoIndent", labelKey: "setAutoIndent", helpKey: "setAutoIndentHelp", type: "checkbox" },
      { key: "softTabs", labelKey: "setSoftTabs", helpKey: "setSoftTabsHelp", type: "checkbox" },
      { key: "tabSize", labelKey: "setTabSize", helpKey: "setTabSizeHelp", type: "number", min: 1, max: 8, step: 1 },
      { key: "preview", labelKey: "setPreview", helpKey: "setPreviewHelp", type: "checkbox" },
    ] },
    { id: "saving", labelKey: "groupSaving", descriptionKey: "groupSavingDesc", items: [
      { key: "autosave", labelKey: "setAutosave", helpKey: "setAutosaveHelp", type: "checkbox" },
      { key: "autosaveDelay", labelKey: "setAutosaveDelay", helpKey: "setAutosaveDelayHelp", type: "number", min: 500, max: 10000, step: 100 },
      { key: "defaultEol", labelKey: "setDefaultEol", helpKey: "setDefaultEolHelp", options: [["LF", "optLf"], ["CRLF", "optCrlf"]] },
    ] },
    { id: "startup", labelKey: "groupStartup", descriptionKey: "groupStartupDesc", items: [
      { key: "reopenLast", labelKey: "setReopenLast", helpKey: "setReopenLastHelp", type: "checkbox" },
    ] },
  ];

  function openSettings() {
    if (S.overlay) return;
    closeMenu();
    const card = el("div", "card settings-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "settings-title");
    const head = el("div", "settings-head");
    const title = el("h2", "", t("settingsLabel"));
    title.id = "settings-title";
    const search = el("input", "field settings-search");
    search.type = "search";
    search.placeholder = t("settingsSearchPlaceholder");
    search.setAttribute("aria-label", t("settingsSearchPlaceholder"));
    const close = el("button", "icon settings-close", "×");
    close.setAttribute("aria-label", t("closeSettings"));
    head.append(title, search, close);
    const layout = el("div", "settings-layout");
    const nav = el("nav", "settings-nav");
    nav.setAttribute("aria-label", t("settingsCategories"));
    const content = el("div", "settings-content");
    const footer = el("div", "settings-footer");
    const status = el("span", "", t("changesApply"));
    status.setAttribute("role", "status");
    const reset = el("button", "ghost", t("resetPreferences"));
    footer.append(status, reset);
    layout.append(nav, content);
    card.append(head, layout, footer);
    const control = mountOverlay(card);
    close.addEventListener("click", () => control.close(null));
    let category = "appearance";
    let revision = 0;
    const sections = [];
    const inputs = new Map();
    const navButtons = new Map();
    const updateFilter = () => {
      const query = search.value.trim().toLowerCase();
      let visible = 0;
      for (const group of sections) {
        let matches = 0;
        for (const row of group.rows) {
          row.node.hidden = !!query && !row.text.includes(query);
          if (!row.node.hidden) matches++;
        }
        group.node.hidden = query ? matches === 0 : group.id !== category;
        if (!group.node.hidden) visible++;
      }
      for (const [id, button] of navButtons) {
        button.classList.toggle("active", !query && id === category);
        button.setAttribute("aria-pressed", String(!query && id === category));
      }
      noResults.hidden = visible > 0;
    };
    const syncInputs = () => {
      for (const [key, input] of inputs) {
        if (input.type === "checkbox") input.checked = !!S.settings[key];
        else input.value = S.settings[key] ?? "";
      }
    };
    const apply = async (patch) => {
      const version = ++revision;
      const langChanged = patch.lang !== undefined && patch.lang !== S.settings.lang;
      Object.assign(S.settings, patch);
      applyThemeAndChrome();
      renderPreview();
      scheduleAutosave();
      if (langChanged) {
        renderRecents();
        updateCounts();
        updateStatus();
        updateState();
        updateTitle(true);
        updateEolBadge();
      }
      status.textContent = t("savingSettings");
      const result = await call("nSettings", { patch });
      if (version !== revision) return;
      if (!result.ok) { status.textContent = t("settingsSaveFailed"); toast(result.error, "err"); return; }
      Object.assign(S.settings, result.settings);
      if (langChanged) {
        control.close(null);
        setTimeout(() => openSettings(), 180);
        return;
      }
      syncInputs();
      status.textContent = t("settingsSaved");
    };
    for (const group of SETTINGS_GROUPS) {
      const button = el("button", "", t(group.labelKey));
      button.addEventListener("click", () => {
        category = group.id;
        search.value = "";
        updateFilter();
        content.scrollTop = 0;
      });
      nav.append(button);
      navButtons.set(group.id, button);
      const section = el("section", "settings-section");
      section.append(el("h3", "", t(group.labelKey)), el("p", "settings-help", t(group.descriptionKey)));
      const rows = [];
      for (const item of group.items) {
        const row = el("div", "settings-row");
        const description = el("div", "settings-description");
        const label = el("label", "settings-label", t(item.labelKey));
        label.htmlFor = `setting-${item.key}`;
        const help = el("div", "settings-help", t(item.helpKey));
        help.id = `setting-help-${item.key}`;
        description.append(label, help);
        let input;
        if (item.options) {
          input = el("select", "field");
          for (const [value, labelKey] of item.options) {
            const option = el("option", "", t(labelKey));
            option.value = value;
            input.append(option);
          }
        } else {
          input = el("input", item.type === "checkbox" ? "" : "field");
          input.type = item.type === "font" ? "text" : item.type;
          if (item.min != null) input.min = item.min;
          if (item.max != null) input.max = item.max;
          if (item.step != null) input.step = item.step;
          if (item.type === "font") {
            input.setAttribute("list", "settings-installed-fonts");
            input.placeholder = t("fontPlaceholder");
            input.maxLength = 200;
          }
        }
        input.id = `setting-${item.key}`;
        input.setAttribute("aria-describedby", help.id);
        input.addEventListener("change", () => {
          if (item.type === "number" && (!input.value || !input.checkValidity())) {
            input.reportValidity();
            syncInputs();
            return;
          }
          const value = item.type === "checkbox" ? input.checked
            : item.type === "number" || item.numeric ? Number(input.value) : input.value.trim();
          void apply({ [item.key]: value });
        });
        inputs.set(item.key, input);
        const field = el("div", `settings-control${item.type === "font" ? " settings-font" : ""}`);
        field.append(input);
        row.append(description, field);
        section.append(row);
        rows.push({
          node: row,
          text: `${t(item.labelKey)} ${t(item.helpKey)} ${t(group.labelKey)}`.toLowerCase(),
        });
      }
      if (group.id === "startup") {
        const locations = el("div", "settings-row");
        const details = el("div", "settings-description");
        details.append(el("div", "settings-label", t("localStorage")),
          el("div", "settings-help", S.app.dataDir),
          el("div", "settings-help", t("localStorageHelp")));
        const reveal = el("button", "ghost", t("openFolder"));
        reveal.addEventListener("click", openDataFolder);
        locations.append(details, reveal);
        section.append(locations);
        rows.push({
          node: locations,
          text: `${t("localStorage")} ${t("openFolder")} ${t("groupStartup")}`.toLowerCase(),
        });
      }
      content.append(section);
      sections.push({ id: group.id, node: section, rows });
    }
    const fontList = el("datalist");
    fontList.id = "settings-installed-fonts";
    card.append(fontList);
    void call("nFonts").then((result) => {
      if (!result.ok) return;
      for (const name of result.fonts) {
        const option = el("option");
        option.value = name;
        fontList.append(option);
      }
    });
    const noResults = el("p", "settings-help", t("noMatchingSettings"));
    content.append(noResults);
    search.addEventListener("input", updateFilter);
    reset.addEventListener("click", () => {
      if (reset.dataset.confirm !== "yes") {
        reset.dataset.confirm = "yes";
        reset.textContent = t("confirmReset");
        return;
      }
      const defaults = defaultSettings();
      const patch = {};
      for (const group of SETTINGS_GROUPS) for (const item of group.items) patch[item.key] = defaults[item.key];
      void apply(patch);
      reset.dataset.confirm = "";
      reset.textContent = t("resetPreferences");
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(card.querySelectorAll("button, input, select"))
        .filter((node) => !node.disabled && node.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    syncInputs();
    updateFilter();
    requestAnimationFrame(() => search.focus());
  }

  function bumpFont(direction) {
    const next = clamp(Math.round((Number(S.settings.fontSize) || 15) + direction), 10, 32);
    persistSettings({ fontSize: next });
    applyFont();
  }

  function resetFont() {
    persistSettings({ fontSize: 15 });
    applyFont();
  }

  function toggleWrap() {
    persistSettings({ wrap: !S.settings.wrap });
    applyThemeAndChrome();
    updateGutter(true);
    syncGutterScroll();
  }

  function toggleLineNumbers() {
    persistSettings({ lineNumbers: !S.settings.lineNumbers });
    applyThemeAndChrome();
    updateGutter(true);
  }

  function toggleSidebar() {
    persistSettings({ sidebar: !S.settings.sidebar });
    applyThemeAndChrome();
  }

  function togglePreview() {
    persistSettings({ preview: !S.settings.preview });
    applyThemeAndChrome();
    renderPreview();
  }

  function toggleAutosave() {
    persistSettings({ autosave: !S.settings.autosave });
    toast(t(S.settings.autosave ? "autosaveOn" : "autosaveOff"));
  }

  function toggleZen() {
    S.zen = !S.zen;
    applyThemeAndChrome();
    focusEditor();
  }

  function updateEolBadge() {
    $("st-eol").textContent = S.eol;
    $("st-enc").textContent = S.bom ? "UTF-8 BOM" : "UTF-8";
  }

  function toggleEol() {
    S.eol = S.eol === "LF" ? "CRLF" : "LF";
    S.dirty = true;
    updateEolBadge();
    updateState();
    updateTitle();
    scheduleSession();
    scheduleAutosave();
    toast(t("lineEndings", { eol: S.eol }));
  }

  async function gotoLine() {
    const answer = await promptText({
      title: t("goToLine"),
      label: t("lineNumber"),
      value: String(lineAt(dom.editor.selectionStart) + 1),
    });
    if (answer == null) return;
    const line = parseInt(answer, 10);
    if (!Number.isFinite(line)) {
      toast(t("enterNumber"), "err");
      return;
    }
    const target = clamp(line - 1, 0, dom.editor.lineCount - 1);
    const position = dom.editor.lineStart(target);
    selectRange(position, position, true);
    focusEditor();
  }

  async function showInFolder(path) {
    const result = await call("nReveal", { path });
    if (!result.ok) toast(result.error, "err");
    return result;
  }

  function revealCurrent() {
    if (!S.path) {
      toast(t("notSavedYetToast"));
      return;
    }
    void showInFolder(S.path);
  }

  function openDataFolder() {
    if (!S.app || !S.app.dataDir) return;
    void showInFolder(S.app.dataDir);
  }

  const SHORTCUTS = [
    ["scSettings", "Ctrl+,"],
    ["scNewNote", "Ctrl+N"],
    ["scOpenFile", "Ctrl+O"],
    ["scSave", "Ctrl+S"],
    ["scSaveAs", "Ctrl+Shift+S"],
    ["scQuickOpen", "Ctrl+P"],
    ["scCommandPalette", "Ctrl+Shift+P"],
    ["scCloseNote", "Ctrl+W"],
    ["scFind", "Ctrl+F"],
    ["scReplace", "Ctrl+H"],
    ["scFindNext", "F3 / Shift+F3"],
    ["scGoto", "Ctrl+G"],
    ["scToggleSidebar", "Ctrl+B"],
    ["scWordWrap", "Alt+Z"],
    ["scPreview", "Ctrl+Shift+V"],
    ["scTheme", "Ctrl+Shift+D"],
    ["scFontSize", "Ctrl+= / Ctrl+- / Ctrl+0"],
    ["scZen", "scZenKeys"],
    ["scQuit", "Ctrl+Q"],
    ["scShortcuts", "F1"],
  ];

  function showShortcuts() {
    const rows = SHORTCUTS.map(([labelKey, keys]) => {
      const label = t(labelKey);
      const keysText = keys === "scZenKeys" ? t("scZenKeys") : keys;
      return `<div class="sc"><span>${escapeHtml(label)}</span><span><kbd>${escapeHtml(keysText)}</kbd></span></div>`;
    }).join("");
    void infoModal(t("keyboardShortcuts"), `<h3>${escapeHtml(t("keyboard"))}</h3>${rows}`);
  }

  function showAbout() {
    const version = (S.app && S.app.version) || "0.1.0";
    const bun = (S.app && S.app.bun) || "";
    const dataDir = (S.app && S.app.dataDir) || "";
    void infoModal(
      t("aboutTitle"),
      `<div class="kv">
        <b>${escapeHtml(t("aboutVersion"))}</b><span>${escapeHtml(version)}</span>
        <b>${escapeHtml(t("aboutRuntime"))}</b><span>${escapeHtml(t("aboutRuntimeValue", { bun: bun || "Bun" }))}</span>
        <b>${escapeHtml(t("aboutRenderer"))}</b><span>${escapeHtml(t("aboutRendererValue"))}</span>
        <b>${escapeHtml(t("aboutStorage"))}</b><span class="mono">${escapeHtml(dataDir)}</span>
      </div>
      <h3>${escapeHtml(t("aboutWhyTitle"))}</h3>
      ${escapeHtml(t("aboutWhy"))}
      <h3>${escapeHtml(t("aboutDataTitle"))}</h3>
      ${escapeHtml(t("aboutData"))}`,
    );
  }

  const COMMANDS = [
    { id: "settings", labelKey: "cmdSettings", hint: "Ctrl+,", run: openSettings },
    { id: "new", labelKey: "cmdNew", hint: "Ctrl+N", run: () => void newDoc() },
    { id: "open", labelKey: "cmdOpen", hint: "Ctrl+O", run: () => void openFlow() },
    { id: "recent", labelKey: "cmdRecent", hint: "Ctrl+P", run: () => openPalette("open") },
    { id: "save", labelKey: "cmdSave", hint: "Ctrl+S", run: () => void saveFlow(false) },
    { id: "saveAs", labelKey: "cmdSaveAs", hint: "Ctrl+Shift+S", run: () => void saveFlow(true) },
    {
      id: "reveal",
      labelKey: "cmdReveal",
      hint: "",
      disabled: () => !S.path,
      run: revealCurrent,
    },
    { id: "close", labelKey: "cmdClose", hint: "Ctrl+W", run: () => void newDoc() },
    { id: "quit", labelKey: "cmdQuit", hint: "Ctrl+Q", run: () => void quitFlow() },
    { id: "undo", labelKey: "cmdUndo", hint: "Ctrl+Z", run: () => { focusEditor(); dom.editor.undo(); } },
    { id: "redo", labelKey: "cmdRedo", hint: "Ctrl+Y", run: () => { focusEditor(); dom.editor.redo(); } },
    { id: "cut", labelKey: "cmdCut", hint: "Ctrl+X", run: () => { focusEditor(); void copyEditorSelection(true); } },
    { id: "copy", labelKey: "cmdCopy", hint: "Ctrl+C", run: () => { focusEditor(); void copyEditorSelection(false); } },
    { id: "selectAll", labelKey: "cmdSelectAll", hint: "Ctrl+A", run: () => { focusEditor(); dom.editor.select(); } },
    { id: "find", labelKey: "cmdFind", hint: "Ctrl+F", run: () => openFind("find") },
    { id: "replace", labelKey: "cmdReplace", hint: "Ctrl+H", run: () => openFind("replace") },
    { id: "goto", labelKey: "cmdGoto", hint: "Ctrl+G", run: () => void gotoLine() },
    {
      id: "wrap",
      labelKey: "cmdWrap",
      hint: "Alt+Z",
      checked: () => S.settings.wrap,
      run: toggleWrap,
    },
    {
      id: "lineNumbers",
      labelKey: "cmdLineNumbers",
      hint: "",
      checked: () => S.settings.lineNumbers,
      run: toggleLineNumbers,
    },
    {
      id: "sidebar",
      labelKey: "cmdSidebar",
      hint: "Ctrl+B",
      checked: () => S.settings.sidebar,
      run: toggleSidebar,
    },
    {
      id: "preview",
      labelKey: "cmdPreview",
      hint: "Ctrl+Shift+V",
      checked: () => S.settings.preview,
      run: togglePreview,
    },
    {
      id: "autosave",
      labelKey: "cmdAutosave",
      hint: "",
      checked: () => S.settings.autosave,
      run: toggleAutosave,
    },
    { id: "theme", labelKey: "cmdTheme", hint: "Ctrl+Shift+D", run: cycleTheme },
    { id: "fontSettings", labelKey: "cmdFontSettings", hint: "", run: () => void toggleFontPanel() },
    { id: "fontUp", labelKey: "cmdFontUp", hint: "Ctrl+=", run: () => bumpFont(1) },
    { id: "fontDown", labelKey: "cmdFontDown", hint: "Ctrl+-", run: () => bumpFont(-1) },
    { id: "fontReset", labelKey: "cmdFontReset", hint: "Ctrl+0", run: resetFont },
    { id: "zen", labelKey: "cmdZen", hint: "", checked: () => S.zen, run: toggleZen },
    { id: "shortcuts", labelKey: "cmdShortcuts", hint: "F1", run: showShortcuts },
    { id: "about", labelKey: "cmdAbout", hint: "", run: showAbout },
    { id: "data", labelKey: "cmdData", hint: "", run: openDataFolder },
    { id: "clearRecents", labelKey: "cmdClearRecents", hint: "", run: () => void clearRecentFiles() },
  ];

  const MENUS = {
    file: ["new", "open", "recent", "-", "save", "saveAs", "-", "reveal", "-", "settings", "-", "close", "quit"],
    edit: ["undo", "redo", "-", "cut", "copy", "selectAll", "-", "find", "replace", "goto"],
    view: [
      "settings",
      "-",
      "wrap",
      "lineNumbers",
      "sidebar",
      "preview",
      "-",
      "fontSettings",
      "fontUp",
      "fontDown",
      "fontReset",
      "-",
      "zen",
      "theme",
      "autosave",
    ],
    help: ["shortcuts", "about", "-", "data", "clearRecents"],
  };

  function commandById(id) {
    return COMMANDS.find((command) => command.id === id);
  }

  function closeMenu() {
    dom.menu.hidden = true;
    document.querySelectorAll(".menubtn.open").forEach((button) => button.classList.remove("open"));
    S.menu = null;
  }

  function openContextMenu(actions, anchor, x, y) {
    closeMenu();
    dom.menu.replaceChildren();
    for (const action of actions) {
      if (!action) { dom.menu.append(el("div", "mi-sep")); continue; }
      const item = el("button", "mi");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.disabled = !!action.disabled;
      item.append(el("span", "label", action.label));
      if (action.hint) item.append(el("span", "hint", action.hint));
      item.addEventListener("click", async () => {
        closeMenu();
        try { await action.run(); } catch (error) { toast(textOf(error), "err"); }
      });
      dom.menu.append(item);
    }
    dom.menu.hidden = false;
    dom.menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - dom.menu.offsetWidth - 8))}px`;
    dom.menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - dom.menu.offsetHeight - 8))}px`;
    S.menu = { name: "context", anchor, element: dom.menu };
    dom.menu.querySelector("button:not(:disabled)")?.focus();
  }

  function openRecentMenu(recent, anchor, x, y) {
    openContextMenu([
      { label: t("openFile"), run: () => openPath(recent.path) },
      { label: t("showInExplorer"), run: () => showInFolder(recent.path) },
      { label: recent.pinned ? t("unpinNote") : t("pinNote"), run: () => toggleRecentPin(recent) },
      null,
      { label: t("removeFromRecents"), run: () => removeRecent(recent.path) },
    ], anchor, x, y);
  }

  function openTextContextMenu(target, x, y) {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const original = target.value;
    const selected = original.slice(start, end);
    const editable = !target.readOnly && !target.disabled;
    const restoreSelection = () => {
      target.focus({ preventScroll: true });
      if (target.value === original) target.setSelectionRange(start, end);
    };
    const replaceSelection = (text) => {
      restoreSelection();
      if (target === dom.editor) { insertText(text); return; }
      if (!document.execCommand("insertText", false, text)) {
        target.setRangeText(text, target.selectionStart, target.selectionEnd, "end");
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };
    const copy = async (cut) => {
      const result = await call("nClipboardWrite", { text: selected });
      if (!result.ok) { toast(result.error, "err"); return; }
      if (cut && target.value === original) replaceSelection("");
    };
    const paste = async () => {
      const result = await call("nClipboardRead");
      if (!result.ok) { toast(result.error, "err"); return; }
      replaceSelection(result.text);
    };
    openContextMenu([
      { label: t("cmdUndo"), hint: "Ctrl+Z", disabled: !editable, run: () => { restoreSelection(); target === dom.editor ? target.undo() : document.execCommand("undo"); } },
      { label: t("cmdRedo"), hint: "Ctrl+Y", disabled: !editable, run: () => { restoreSelection(); target === dom.editor ? target.redo() : document.execCommand("redo"); } },
      null,
      { label: t("cmdCut"), hint: "Ctrl+X", disabled: !editable || !selected || target.type === "password", run: () => copy(true) },
      { label: t("cmdCopy"), hint: "Ctrl+C", disabled: !selected || target.type === "password", run: () => copy(false) },
      { label: t("paste"), hint: "Ctrl+V", disabled: !editable, run: paste },
      ...(target === dom.editor ? [
        { label: t("ctxPasteImage"), disabled: !editable, run: pasteClipboardImage },
      ] : []),
      null,
      { label: t("cmdSelectAll"), hint: "Ctrl+A", disabled: !original.length, run: () => { target.focus(); target.select(); } },
      ...(target === dom.editor ? [null,
        { label: t("ctxFind"), hint: "Ctrl+F", run: () => openFind("find") },
        { label: t("ctxReplace"), hint: "Ctrl+H", run: () => openFind("replace") },
      ] : []),
    ], target, x, y);
  }

  function openMenu(name, anchor) {
    const definition = MENUS[name];
    if (!definition) return;
    const wasOpen = S.menu && S.menu.name === name;
    closeMenu();
    if (wasOpen) return;

    dom.menu.replaceChildren();
    for (const id of definition) {
      if (id === "-") {
        dom.menu.append(el("div", "mi-sep"));
        continue;
      }
      const command = commandById(id);
      if (!command) continue;
      const item = el("button", "mi");
      item.type = "button";
      item.append(el("span", "check", command.checked && command.checked() ? "✓" : ""));
      item.append(el("span", "label", t(command.labelKey)));
      item.append(el("span", "hint", command.hint || ""));
      if (command.disabled && command.disabled()) {
        item.disabled = true;
      } else {
        item.addEventListener("click", () => {
          closeMenu();
          setTimeout(() => command.run(), 10);
        });
      }
      dom.menu.append(item);
    }

    dom.menu.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const width = dom.menu.offsetWidth;
    dom.menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 10))}px`;
    dom.menu.style.top = `${rect.bottom + 5}px`;
    anchor.classList.add("open");
    S.menu = { name, anchor, element: dom.menu };
  }

  /* ------------------------------------------------------------------ */
  /* boot                                                               */
  /* ------------------------------------------------------------------ */

  function fatal(message) {
    document.body.innerHTML = "";
    const box = el("div");
    box.style.cssText =
      "display:flex;height:100vh;align-items:center;justify-content:center;padding:40px;font:14px/1.6 var(--ui);color:#e7e9f0;background:#0e1015;";
    const inner = el("div");
    inner.style.cssText = "max-width:520px";
    inner.append(el("div", null, t("couldNotStart")));
    const detail = el("div", null, String(message));
    detail.style.cssText = "margin-top:10px;opacity:.7;font-size:12.5px;white-space:pre-wrap";
    inner.append(detail);
    box.append(inner);
    document.body.append(box);
  }

  async function boot(session, startupPath) {
    const last = S.recents[0];
    if (session && session.content && session.dirty) {
      setDoc({
        path: session.path,
        dir: session.dir,
        name: session.name,
        content: session.content,
        eol: session.eol,
        bom: session.bom,
        mtime: session.mtime,
        dirty: true,
      });
      showBanner(
        session.path
          ? t("recoveredChanges", { name: session.name, when: timeAgo(session.at) })
          : t("recoveredNote", { when: timeAgo(session.at) }),
        [
          {
            label: t("discard"),
            run: async () => {
              await call("nSessionClear");
              startBlank(false);
            },
          },
        ],
      );
      if (startupPath) await openPath(startupPath);
      return;
    }

    if (startupPath) {
      // Establish a usable blank document even if the requested file is missing.
      startBlank(false);
      await openPath(startupPath, { force: true });
      return;
    }

    if (S.settings.reopenLast && last) {
      const opened = await openPath(last.path, { force: true, silent: true });
      if (opened) return;
    }

    startBlank(true);
  }

  async function runSmoke(startup) {
    const checks = {};
    const performanceReport = {};
    const failed = [];
    const check = (name, condition) => {
      checks[name] = condition ? "ok" : "FAIL";
      if (!condition) failed.push(name);
    };

    check(
      "bindings",
      ["nReady", "nOpen", "nSave", "nListDir", "nSession", "nTitle"].every(
        (name) => typeof window[name] === "function",
      ),
    );
    check("dom", !!(dom.editor && dom.gutter && dom.gutterLines && dom.panes && $("statusbar")));
    const blankContextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    $("sidebar").dispatchEvent(blankContextMenu);
    check("noBrowserMenuOnBlank", blankContextMenu.defaultPrevented);
    check("sidebarContextMenu", !dom.menu.hidden && dom.menu.textContent.includes("New note")
      && dom.menu.textContent.includes("Open file…"));
    closeMenu();
    dom.editor.setSelectionRange(0, Math.min(3, dom.editor.value.length));
    dom.editor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    check("editorContextMenu", !dom.menu.hidden && ["Undo", "Redo", "Cut", "Copy", "Paste", "Select all"]
      .every((name) => Array.from(dom.menu.querySelectorAll(".label")).some((label) => label.textContent === name)));
    closeMenu();
    check("settings", Number(S.settings.fontSize) >= 10);
    check("lines", S.lineCount === dom.editor.value.split("\n").length);
    check("gutter", !!dom.gutter.textContent);
    check("markdown", renderMarkdown("**bold**").includes("<strong>bold</strong>"));
    check("noteTitle", contentTitle("  รายการซื้อของ\nรายละเอียด") === "รายการซื้อของ");
    check("emptyTitle", contentTitle("") === t("untitled"));
    check("theme", /theme-(dark|light)/.test(document.body.className));
    check("toolbarIconsVisible", ["btn-theme", "btn-settings"].every((id) => {
      const icon = $(id).querySelector("svg");
      const bounds = icon && icon.getBoundingClientRect();
      return bounds && bounds.width >= 15 && bounds.height >= 15;
    }));
    check("css", getComputedStyle(dom.editor).fontFamily.length > 0);
    check("status", $("st-pos").textContent.startsWith("Ln "));

    if (S.app.platform === "win32") {
      const nativeWindow = await call("nWindow", { action: "status" });
      check("customTitlebar", nativeWindow.ok && nativeWindow.frameless && !$("window-controls").hidden);
      check("windowButtons", $("window-controls").children.length === 3
        && $("window-minimize").getAttribute("aria-label") === "Minimize"
        && $("window-minimize").textContent.trim() === "─");
      const topbar = $("topbar");
      topbar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
      topbar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0 }));
      const doubleClicked = await call("nWindow", { action: "status" });
      check("titlebarDoubleClick", doubleClicked.ok && doubleClicked.maximized);
      topbar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0 }));
      const doubleRestored = await call("nWindow", { action: "status" });
      check("titlebarDoubleClickRestore", doubleRestored.ok && !doubleRestored.maximized);
      const maximized = await call("nWindow", { action: "maximize" });
      check("maximize", maximized.ok && maximized.maximized);
      const restored = await call("nWindow", { action: "maximize" });
      check("restore", restored.ok && !restored.maximized);
      const badResize = await call("nWindow", { action: "resize", edge: "nope" });
      check("resizeBinding", !badResize.ok);
      check("rightEdgeClear", parseFloat(getComputedStyle(dom.panes).paddingRight) >= 5);
      const controlsRect = $("window-controls").getBoundingClientRect();
      const topbarRect = $("topbar").getBoundingClientRect();
      check("windowControlsPinned", Math.abs(controlsRect.right - topbarRect.right) < 2);
    }
    await toggleFontPanel();
    check("fontPanel", fontPanel && !fontPanel.hidden && $("installed-fonts").children.length > 0);
    const fontBefore = { fontFamily: S.settings.fontFamily, fontWeight: S.settings.fontWeight,
      fontSize: S.settings.fontSize, lineHeight: S.settings.lineHeight };
    $("font-family").value = "Arial";
    $("font-size").value = "18";
    $("font-height").value = "1.8";
    $("font-family").dispatchEvent(new Event("change", { bubbles: true }));
    check("fontApplied", dom.editor.style.fontFamily.includes("Arial")
      && getComputedStyle(dom.editor).fontSize === "18px"
      && getComputedStyle(dom.editor).lineHeight === "32px");
    persistSettings(fontBefore);
    applyFont();
    check("defaultConsolas", getComputedStyle(dom.editor).fontFamily.toLowerCase().includes("consolas"));
    fontPanel.hidden = true;
    openSettings();
    check("settingsPage", !!document.querySelector(".settings-card") && $("setting-autoIndent") != null);
    check("languageSetting", !!$("setting-lang") && $("setting-lang").options.length === 2);
    const settingsBefore = { spellcheck: S.settings.spellcheck, autoIndent: S.settings.autoIndent,
      tabSize: S.settings.tabSize, defaultEol: S.settings.defaultEol, autosaveDelay: S.settings.autosaveDelay };
    $("setting-spellcheck").checked = true;
    $("setting-spellcheck").dispatchEvent(new Event("change", { bubbles: true }));
    const storedSettings = await call("nReady");
    check("settingsPersist", storedSettings.settings.spellcheck === true && dom.editor.spellcheck);
    const settingsSearch = document.querySelector(".settings-search");
    settingsSearch.value = "autosave";
    settingsSearch.dispatchEvent(new Event("input", { bubbles: true }));
    check("settingsSearch", !$("setting-autosave").closest(".settings-section").hidden
      && $("setting-theme").closest(".settings-row").hidden);
        S.overlay.close(null);
    Object.assign(S.settings, settingsBefore);
    await call("nSettings", { patch: settingsBefore });
    applyThemeAndChrome();

    S.settings.lang = "th";
    applyThemeAndChrome();
    check("languageThai", document.documentElement.lang === "th" && $("btn-save").textContent === t(S.path && !S.dirty ? "saved" : "save"));
    S.settings.lang = "en";
    applyThemeAndChrome();
    check("languageEnglish", document.documentElement.lang === "en" && $("btn-save").textContent === t(S.path && !S.dirty ? "saved" : "save"));


    const listing = await call("nListDir", { path: S.app.notesDir });
    check("browse", listing.ok && listing.listing.path.length > 0);
    const sample = "ทดสอบ save\nNISIO smoke";
    const saved = await call("nSave", { content: sample, eol: "LF" });
    check("defaultSave", saved.ok && saved.file.dir === S.app.notesDir);
    check("recentTitle", saved.ok && saved.recents[0].name === "ทดสอบ save");
    if (saved.ok) {
      if (window.__NISIO_SHELL_SMOKE__) {
        const revealFile = await call("nReveal", { path: saved.file.path });
        check("nativeRevealFile", revealFile.ok);
        const revealFolder = await call("nReveal", { path: saved.file.dir });
        check("nativeRevealFolder", revealFolder.ok);
      }
      const opened = await call("nOpen", { path: saved.file.path });
      check("readSaved", opened.ok && opened.file.content === sample);
      const byTitle = await call("nSearchNotes", { query: "ทดสอบ save" });
      check("searchByTitle", byTitle.ok && byTitle.results.some((entry) => entry.path === saved.file.path));
      const byContent = await call("nSearchNotes", { query: "NISIO smoke" });
      check("searchByContent", byContent.ok && byContent.results.some((entry) => entry.path === saved.file.path));
      const noteId = saved.file.name.replace(/\.txt$/i, "");
      const byId = await call("nSearchNotes", { query: noteId });
      check("searchById", byId.ok && byId.results.some((entry) => entry.path === saved.file.path));
      $("note-search").value = noteId;
      $("note-search").dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 350));
      check("liveNoteSearch", noteSearchResults.some((entry) => entry.path === saved.file.path)
        && $("recents").querySelector(".recent-snippet") != null);
      $("note-search").value = "";
      $("note-search").dispatchEvent(new Event("input", { bubbles: true }));
      check("clearNoteSearch", $("note-search-status").hidden && noteSearchResults.length === 0);
      if (opened.ok) {
        applyOpened(opened);
        const selected = document.querySelectorAll(".recent.active");
        check("activeRecent", selected.length === 1
          && selected[0].getAttribute("aria-current") === "page"
          && selected[0].querySelector(".recent-name").textContent === "ทดสอบ save");
        const toastCount = dom.toasts.children.length;
        await openPath(saved.file.path, { force: true });
        check("noOpenToast", dom.toasts.children.length === toastCount);
        startBlank(false);
        check("blankClearsSelection", !document.querySelector(".recent.active"));
      }
      const copied = await call("nSave", {
        path: joinPath(S.app.notesDir, "smoke-save-as.txt"),
        content: sample,
      });
      check("saveAs", copied.ok && copied.file.name === "smoke-save-as.txt");
      if (copied.ok) {
        const pinned = await call("nRecents", { pin: true, path: saved.file.path });
        const pinnedEntry = pinned.ok
          ? pinned.recents.find((entry) => entry.path === saved.file.path)
          : null;
        check("pinSet", !!pinnedEntry && pinnedEntry.pinned === true);
        if (pinned.ok) {
          S.recents = pinned.recents;
          S.settings.recents = S.recents;
          renderRecents();
        }
        const firstRow = $("recents").firstElementChild;
        check("pinnedOnTop", !!firstRow
          && firstRow.querySelector(".recent-name")?.textContent === "ทดสอบ save"
          && !!firstRow.querySelector(".recent-pin"));
        const unpinned = await call("nRecents", { pin: false, path: saved.file.path });
        const unpinnedEntry = unpinned.ok
          ? unpinned.recents.find((entry) => entry.path === saved.file.path)
          : null;
        check("pinCleared", !!unpinnedEntry && unpinnedEntry.pinned !== true);
        if (unpinned.ok) {
          S.recents = unpinned.recents;
          S.settings.recents = S.recents;
          renderRecents();
        }
        const moved = await call("nRecents", { move: true, path: saved.file.path, beforePath: copied.file.path });
        const order = moved.recents.map((entry) => entry.path).join("|");
        const reopened = await call("nOpen", { path: copied.file.path });
        check("openKeepsOrder", reopened.ok && reopened.recents.map((entry) => entry.path).join("|") === order);
        const resaved = await call("nSave", { path: copied.file.path, content: sample });
        check("saveKeepsOrder", resaved.ok && resaved.recents.map((entry) => entry.path).join("|") === order);
        const persisted = await call("nReady");
        check("reorderPersisted", persisted.settings.recents.map((entry) => entry.path).join("|") === order);
        S.recents = moved.recents;
        renderRecents();
        check("draggableRecents", $("recents").querySelectorAll(".recent[draggable='true']").length === S.recents.length);
      }
    }

    if (saved.ok && S.app.platform === "win32") {
      startBlank(false);
      const nativeDialog = window.nFileDialog;
      let suggestedName = "";
      try {
        window.nFileDialog = (options) => {
          suggestedName = options.name;
          return { ok: true, path: saved.file.path, dir: saved.file.dir };
        };
        const transfer = new DataTransfer();
        transfer.items.add(new File([sample], saved.file.name, { type: "text/plain" }));
        await handleDrop({ dataTransfer: transfer });
        check("dropSelectsOriginal", suggestedName === saved.file.name && S.path === saved.file.path
          && dom.editor.value === sample && !S.dirty);
        check("saveButtonSaved", $("btn-save").disabled && $("btn-save").textContent === t("saved"));
        insertText("edited");
        check("saveButtonDirty", !$("btn-save").disabled && $("btn-save").textContent === t("save"));
        const saveWorked = await saveFlow();
        check("saveButtonAfterSave", $("btn-save").disabled && $("btn-save").textContent === t("saved"));
        const reopened = await call("nOpen", { path: saved.file.path });
        check("dropSavesOriginal", saveWorked && reopened.ok && reopened.file.content === `edited${sample}`);
      } finally {
        window.nFileDialog = nativeDialog;
        startBlank(false);
      }
    }

    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const badImage = await call("nImageSave", { base64: "not-an-image" });
    check("imageReject", !badImage.ok);
    startBlank(false);
    const pngBytes = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0));
    await insertImageAttachment(new File([pngBytes], "pixel.png", { type: "image/png" }));
    const imageMatch = /\((nisio-asset:[0-9a-f-]{36}\.png)\)/.exec(dom.editor.value);
    check("imageInsert", !!imageMatch && S.imageCache.size > 0);
    if (imageMatch) {
      dom.preview.innerHTML = renderMarkdown(`![image](${imageMatch[1]})`);
      await hydratePreviewImages();
      const image = dom.preview.querySelector("img.note-image");
      check("imagePreview", !!image && (image.getAttribute("src") || "").startsWith("data:image/png;base64,"));
    }
    startBlank(false);
    try {
      const transfer = new DataTransfer();
      transfer.items.add(new File([pngBytes], "pasted.png", { type: "image/png" }));
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: transfer });
      dom.editor.dispatchEvent(paste);
      check("imagePasteHandled", paste.defaultPrevented);
      await new Promise((resolve) => setTimeout(resolve, 300));
      check("imagePasteInserted", dom.editor.value.includes("](nisio-asset:"));
    } catch (error) {
      check("imagePasteHandled", false);
    }
    startBlank(false);

    check("resizers", !!(dom.sidebarResizer && dom.paneResizer));
    const pointerEvent = (type, x, buttons) => new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons,
      clientX: x,
      clientY: 120,
      pointerId: 1,
    });
    const sidebarBefore = parseInt(document.documentElement.style.getPropertyValue("--sidebar"), 10) || 218;
    dom.sidebarResizer.dispatchEvent(pointerEvent("pointerdown", 250, 1));
    dom.sidebarResizer.dispatchEvent(pointerEvent("pointermove", 310, 1));
    dom.sidebarResizer.dispatchEvent(pointerEvent("pointerup", 310, 0));
    const sidebarAfter = parseInt(document.documentElement.style.getPropertyValue("--sidebar"), 10) || 0;
    check("sidebarResize", sidebarAfter > sidebarBefore);
    persistSettings({ sidebar: true, sidebarWidth: 218, preview: true, previewWidth: 50 });
    applyThemeAndChrome();
    const previewBefore = parseFloat(document.documentElement.style.getPropertyValue("--preview-size")) || 50;
    const paneRect = dom.preview.getBoundingClientRect();
    dom.paneResizer.dispatchEvent(pointerEvent("pointerdown", paneRect.left, 1));
    dom.paneResizer.dispatchEvent(pointerEvent("pointermove", paneRect.left - 80, 1));
    dom.paneResizer.dispatchEvent(pointerEvent("pointerup", paneRect.left - 80, 0));
    const previewAfter = parseFloat(document.documentElement.style.getPropertyValue("--preview-size")) || 0;
    check("previewResize", previewAfter > previewBefore);
    persistSettings({ preview: false, previewWidth: 50 });
    applyThemeAndChrome();

    check("sidebarButton", !!$("btn-sidebar"));
    check("menuButton", !!$("btn-menu"));
    check("drawerMatchesViewport", document.body.classList.contains("drawer-open")
      === (S.drawerMode && S.settings.sidebar));
    const sidebarSetting = S.settings.sidebar;
    $("btn-sidebar").click();
    check("sidebarToggle", S.settings.sidebar === !sidebarSetting
      && document.body.classList.contains("no-sidebar") === !S.settings.sidebar
      && getComputedStyle($("sidebar")).display === (S.settings.sidebar ? "flex" : "none")
      && $("btn-sidebar").getAttribute("aria-pressed") === String(S.settings.sidebar));
    $("btn-sidebar").click();

    const realNarrowQuery = narrowQuery;
    narrowQuery = { matches: true };
    S.settings.sidebar = true;
    applyThemeAndChrome();
    check("drawerModeOnNarrow", S.drawerMode && document.body.classList.contains("drawer-mode"));
    check("drawerOpenWithSidebar", document.body.classList.contains("drawer-open") && !dom.backdrop.hidden);
    toggleSidebar();
    check("drawerCloses", !S.settings.sidebar
      && !document.body.classList.contains("drawer-open") && dom.backdrop.hidden);
    toggleSidebar();
    check("drawerOpens", S.settings.sidebar
      && document.body.classList.contains("drawer-open") && !dom.backdrop.hidden);
    narrowQuery = { matches: false };
    applyThemeAndChrome();
    check("drawerKeptWide", !S.drawerMode && !document.body.classList.contains("drawer-open")
      && !document.body.classList.contains("no-sidebar")
      && getComputedStyle($("sidebar")).display !== "none");
    narrowQuery = realNarrowQuery;
    applyThemeAndChrome();

    check("editorVirtualized", !!dom.editor.querySelector(".cm-content") && dom.editor.tagName !== "TEXTAREA");
    const virtualDoc = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    dom.editor.value = virtualDoc;
    lineIndexDirty = true;
    dom.editor.getBoundingClientRect();
    dom.editor.scrollTop = 20000;
    dom.editor.getBoundingClientRect();
    renderGutterWindow(true);
    const virtualLines = dom.gutterLines.textContent.split("\n");
    check("gutterVirtual", virtualLines.length < 200 && Number(virtualLines[0]) > 1
      && dom.editor.scrollHeight > dom.editor.clientHeight);
    startBlank(false);

    setDoc({ content: "a hit b hit c hit z" });
    dom.findbar.hidden = false;
    dom.findInput.value = "hit";
    dom.editor.setSelectionRange(0, 0);
    findStep(1);
    check("findNextFromCaret", dom.editor.selectionStart === 2);
    findStep(1);
    check("findNextFromSelection", dom.editor.selectionStart === 8);
    dom.editor.setSelectionRange(15, 15);
    findStep(-1);
    check("findPreviousFromCaret", dom.editor.selectionStart === 8);
    dom.editor.setSelectionRange(0, 0);
    findStep(-1);
    check("findPreviousWrap", dom.editor.selectionStart === 14);
    dom.editor.setSelectionRange(dom.editor.value.length, dom.editor.value.length);
    findStep(1);
    check("findNextWrap", dom.editor.selectionStart === 2);
    dom.findbar.hidden = true;

    const nativeSave = window.nSave;
    const nativeReveal = window.nReveal;
    try {
      let revealRequested = "";
      window.nReveal = (payload) => {
        revealRequested = payload.path;
        return { ok: false, error: "smoke: Explorer could not open the file" };
      };
      const path = joinPath(S.app.notesDir, "reveal-smoke.txt");
      openRecentMenu({ path }, $("recents"), 100, 100);
      Array.from(dom.menu.querySelectorAll("button"))
        .find((button) => button.textContent.includes(t("showInExplorer"))).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      check("revealMenuCallsBinding", revealRequested === path);
      check("revealFailureVisible", dom.toasts.textContent.includes("smoke: Explorer could not open the file"));
    } finally {
      window.nReveal = nativeReveal;
      closeMenu();
    }
    try {
      const paths = [];
      window.nSave = async (payload) => {
        paths.push(payload.path);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true, file: {
          path: payload.path || joinPath(S.app.notesDir, "queued-smoke.txt"),
          dir: S.app.notesDir, name: "queued-smoke.txt", mtime: 1,
        } };
      };
      startBlank(false);
      dom.editor.value = "queued saves";
      const saves = await Promise.all([saveFlow(), saveFlow()]);
      check("serializedSaves", saves.every(Boolean) && paths.length === 2
        && paths[0] === null && paths[1] === S.path);

      let finishSave;
      window.nSave = () => new Promise((resolve) => { finishSave = resolve; });
      const pendingSave = saveFlow();
      await Promise.resolve();
      startBlank(false);
      finishSave({ ok: true, file: { path: "stale.txt", name: "stale.txt", mtime: 1 } });
      check("staleSaveIgnored", !(await pendingSave) && S.path === null && dom.editor.value === "");
    } finally {
      window.nSave = nativeSave;
      startBlank(false);
    }

    const largeContent = Array.from({ length: 12000 }, (_, i) => `line ${i} text`).join("\n");
    let measuredAt = performance.now();
    setDoc({ content: largeContent });
    performanceReport.load12000LinesMs = Math.round(performance.now() - measuredAt);
    await dom.editor.whenMeasured();
    const viewport = dom.editor.getBoundingClientRect();
    check("largeEditorBounded", viewport.height <= dom.panes.clientHeight + 1
      && viewport.bottom <= $("statusbar").getBoundingClientRect().top + 1);
    dom.editor.scrollTop = dom.editor.scrollHeight;
    await dom.editor.whenMeasured();
    renderGutterWindow(true);
    check("largeScrollBottom", dom.editor.scrollTop > 0
      && Number(dom.gutterLines.textContent.trim().split("\n").at(-1)) === 12000);
    dom.editor.scrollTop = 0;
    await dom.editor.whenMeasured();
    renderGutterWindow(true);
    check("largeScrollTop", dom.editor.scrollTop === 0 && dom.gutterLines.textContent.startsWith("1\n"));
    measuredAt = performance.now();
    updateCounts();
    performanceReport.count12000LinesMs = Math.round(performance.now() - measuredAt);
    check("largeCountsCurrent", $("st-chars").textContent === t("chars", { n: fmtNum(largeContent.length) }));
    check("largeTextVirtual", dom.editor.renderedLines() < 200);
    check("visibleScrollbar", getComputedStyle(dom.editor.querySelector(".cm-scroller")).overflowY === "scroll"
      && parseFloat(getComputedStyle(dom.editor.querySelector(".cm-scroller"), "::-webkit-scrollbar").width) >= 12);

    const hugeContent = Array.from({ length: 100000 }, (_, i) => `line ${i} ภาษาไทย text`).join("\n");
    startBlank(false);
    const textClipboard = new DataTransfer();
    textClipboard.setData("text/plain", hugeContent);
    const pasteText = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: textClipboard });
    measuredAt = performance.now();
    dom.editor.querySelector(".cm-content").dispatchEvent(pasteText);
    performanceReport.paste100000LinesMs = Math.round(performance.now() - measuredAt);
    check("hugePaste", pasteText.defaultPrevented && dom.editor.value === hugeContent);
    await dom.editor.whenMeasured();
    check("hugeTextVirtual", dom.editor.lineCount === 100000 && dom.editor.renderedLines() < 200);
    dom.editor.revealRange(hugeContent.length, hugeContent.length);
    await dom.editor.whenMeasured();
    check("hugeScrollEnd", dom.editor.scrollTop > 0
      && dom.editor.querySelector(".cm-content").textContent.includes("line 99999 ภาษาไทย text"));
    const editTimes = [];
    for (let i = 0; i < 20; i++) {
      measuredAt = performance.now();
      insertText("x");
      scheduleEditorMetrics(true);
      editTimes.push(performance.now() - measuredAt);
      await dom.editor.whenMeasured();
    }
    editTimes.sort((a, b) => a - b);
    performanceReport.edit100000LinesP95Ms = Math.round(editTimes[18]);
    check("hugeEditsPreserveText", dom.editor.value === hugeContent + "x".repeat(20));
    dom.editor.undo();
    check("hugeUndo", dom.editor.textLength < hugeContent.length + 20);
    dom.editor.redo();
    check("hugeRedo", dom.editor.value === hugeContent + "x".repeat(20));
    check("hugeLineLookup", lineAt(hugeContent.length) === 99999
      && dom.editor.lineStart(99999) === hugeContent.lastIndexOf("\n") + 1);
    const scroller = dom.editor.querySelector(".cm-scroller");
    dom.editor.setRangeText("\n" + "long text ".repeat(500), dom.editor.textLength, dom.editor.textLength, "end");
    await dom.editor.whenMeasured();
    dom.editor.scrollLeft = dom.editor.scrollWidth;
    check("horizontalScroll", dom.editor.scrollLeft > 0);
    dom.editor.configure({ ...S.settings, wrap: true });
    await dom.editor.whenMeasured();
    check("wordWrap", dom.editor.querySelector(".cm-lineWrapping") != null
      && scroller.scrollWidth <= scroller.clientWidth + 1);
    dom.editor.configure(S.settings);
    setDoc({ content: "  alpha" });
    dom.editor.setSelectionRange(dom.editor.textLength, dom.editor.textLength);
    dom.editor.querySelector(".cm-content").dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", bubbles: true, cancelable: true,
    }));
    check("enterAutoIndent", dom.editor.value === "  alpha\n  ");
    dom.editor.querySelector(".cm-content").dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab", code: "Tab", bubbles: true, cancelable: true,
    }));
    check("tabInsertion", dom.editor.value === "  alpha\n  " + indentUnit());
    dom.editor.setSelectionRange(0, 2);
    dom.editor.setRangeText("ภาษาไทย", 0, 2, "select");
    check("selectionReplacement", dom.editor.value.startsWith("ภาษาไทยalpha")
      && dom.editor.selectionStart === 0 && dom.editor.selectionEnd === 7);
    dom.editor.select();
    insertText("first\r\nsecond\rthird");
    check("clipboardLineEndings", dom.editor.value === "first\nsecond\nthird"
      && dom.editor.selectionStart === dom.editor.textLength);
    startBlank(false);

    void call("nSmoke", {
      ok: failed.length === 0,
      failed,
      checks,
      startup,
      performance: performanceReport,
      doc: { path: S.path, lines: S.lineCount, chars: dom.editor.value.length },
      settings: { theme: S.settings.theme, fontSize: S.settings.fontSize },
      version: S.app && S.app.version,
      bun: S.app && S.app.bun,
    });
  }

  /* ------------------------------------------------------------------ */
  /* events                                                             */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    bindSplitters();

    document.addEventListener("contextmenu", (event) => {
      const handled = event.defaultPrevented;
      event.preventDefault();
      if (handled) return;
      const target = event.target;
      if (target.closest("#editor")) { openTextContextMenu(dom.editor, event.clientX, event.clientY); return; }
      const textInput = target.closest("textarea, input:not([type]), input[type='text'], input[type='search'], input[type='password']");
      if (textInput) { openTextContextMenu(textInput, event.clientX, event.clientY); return; }
      if (S.overlay || target.closest("#menu, #topbar")) return;
      const sidebar = target.closest("#sidebar");
      openContextMenu([
        { label: t("cmdNew"), hint: "Ctrl+N", run: newDoc },
        { label: t("cmdOpen"), hint: "Ctrl+O", run: openFlow },
        ...(!sidebar ? [
          { label: t("cmdSave"), hint: "Ctrl+S", run: () => saveFlow(false) },
          { label: t("cmdSaveAs"), hint: "Ctrl+Shift+S", run: () => saveFlow(true) },
        ] : []),
        null,
        { label: t("cmdSettings"), hint: "Ctrl+,", run: openSettings },
      ], sidebar || $("workarea"), event.clientX, event.clientY);
    });

    dom.menu.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(dom.menu.querySelectorAll("button:not(:disabled)"));
      if (!items.length) return;
      let index = items.indexOf(document.activeElement);
      if (event.key === "Home") index = 0;
      else if (event.key === "End") index = items.length - 1;
      else index = (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[index].focus();
    });

    async function windowAction(action, edge) {
      const result = await call("nWindow", edge ? { action, edge } : { action });
      if (result.closeRequested) { void quitFlow(); return; }
      if (!result.ok) { toast(result.error, "err"); return; }
      if (typeof result.maximized === "boolean") S.maximized = result.maximized;
      const button = $("window-maximize");
      button.textContent = result.maximized ? "❐" : "□";
      button.title = result.maximized ? t("winRestore") : t("winMaximize");
      button.setAttribute("aria-label", button.title);
    }
    const RESIZE_EDGE = 5;
    const RESIZE_CURSORS = {
      left: "ew-resize",
      right: "ew-resize",
      top: "ns-resize",
      bottom: "ns-resize",
      "top-left": "nwse-resize",
      "bottom-right": "nwse-resize",
      "top-right": "nesw-resize",
      "bottom-left": "nesw-resize",
    };
    const resizeEdgeAt = (x, y) => {
      if (S.app?.platform !== "win32" || S.maximized) return null;
      const nearLeft = x < RESIZE_EDGE;
      const nearRight = x >= window.innerWidth - RESIZE_EDGE;
      const nearTop = y < RESIZE_EDGE;
      const nearBottom = y >= window.innerHeight - RESIZE_EDGE;
      if (nearTop && nearLeft) return "top-left";
      if (nearTop && nearRight) return "top-right";
      if (nearBottom && nearLeft) return "bottom-left";
      if (nearBottom && nearRight) return "bottom-right";
      if (nearLeft) return "left";
      if (nearRight) return "right";
      if (nearTop) return "top";
      if (nearBottom) return "bottom";
      return null;
    };
    document.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const edge = resizeEdgeAt(event.clientX, event.clientY);
      if (!edge) return;
      event.preventDefault();
      event.stopPropagation();
      void windowAction("resize", edge);
    }, true);
    let cursorFrame = 0;
    let cursorX = 0;
    let cursorY = 0;
    document.addEventListener("mousemove", (event) => {
      if (document.body.classList.contains("col-resizing")) return;
      cursorX = event.clientX;
      cursorY = event.clientY;
      if (cursorFrame) return;
      cursorFrame = requestAnimationFrame(() => {
        cursorFrame = 0;
        const edge = resizeEdgeAt(cursorX, cursorY);
        const cursor = edge ? RESIZE_CURSORS[edge] : "";
        if (document.body.style.cursor !== cursor) document.body.style.cursor = cursor;
      });
    });
    window.addEventListener("blur", () => {
      document.body.style.cursor = "";
    });
    $("window-minimize").addEventListener("click", () => void windowAction("minimize"));
    $("window-maximize").addEventListener("click", () => void windowAction("maximize"));
    $("window-close").addEventListener("click", () => void quitFlow());
    $("topbar").addEventListener("mousedown", (event) => {
      if (S.app?.platform !== "win32" || event.button !== 0
        || event.target.closest("button, input, nav")) return;
      event.preventDefault();
      closeMenu();
      // Do not enter Windows' move loop for a plain click: it consumes the
      // second click, preventing the browser from delivering dblclick.
      const startX = event.screenX;
      const startY = event.screenY;
      const cancel = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", cancel);
        window.removeEventListener("blur", cancel);
      };
      const move = (next) => {
        if (!(next.buttons & 1)) { cancel(); return; }
        if (Math.abs(next.screenX - startX) < 5 && Math.abs(next.screenY - startY) < 5) return;
        cancel();
        void windowAction("drag");
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", cancel);
      window.addEventListener("blur", cancel);
    });
    $("topbar").addEventListener("contextmenu", (event) => {
      if (S.app?.platform !== "win32" || event.target.closest("button, input, nav")) return;
      event.preventDefault();
      void windowAction("systemMenu");
    });
    document.addEventListener("keydown", (event) => {
      if (S.app?.platform !== "win32") return;
      if (event.altKey && event.code === "Space") {
        event.preventDefault();
        void windowAction("systemMenu");
      }
    });
    let statusTimer = 0;
    window.addEventListener("resize", () => {
      syncGutterScroll();
      if (S.app?.platform !== "win32") return;
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => void windowAction("status"), 120);
    });
    $("topbar").addEventListener("dblclick", (event) => {
      if (S.app?.platform !== "win32" || event.target.closest("button, input, nav")) return;
      void windowAction("maximize");
    });
    $("btn-open").addEventListener("click", () => void openFlow());
    $("btn-sidebar").addEventListener("click", toggleSidebar);
    $("btn-menu").addEventListener("click", () => openPalette("command"));
    dom.backdrop.addEventListener("click", () => {
      if (!S.settings.sidebar) return;
      persistSettings({ sidebar: false });
      applyThemeAndChrome();
    });
    $("btn-save").addEventListener("click", () => void saveFlow(false));
    $("btn-theme").addEventListener("click", cycleTheme);
    $("btn-settings").addEventListener("click", openSettings);
    $("note-search").addEventListener("input", () => scheduleNoteSearch());
    $("note-search").addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        $("note-search").value = "";
        scheduleNoteSearch();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        $("recents").querySelector("button")?.focus();
      }
    });
    $("btn-new").addEventListener("click", () => void newDoc());
    $("btn-browse").addEventListener("click", () => void openFlow());
    $("btn-clear-recents").addEventListener("click", () => void clearRecentFiles());
    $("banner-close").addEventListener("click", hideBanner);
    $("st-name").addEventListener("click", revealCurrent);
    $("st-eol").addEventListener("click", toggleEol);
    $("st-enc").addEventListener("click", () => toast(t("utf8Info")));

    document.querySelectorAll(".menubtn").forEach((button) => {
      button.addEventListener("click", () => openMenu(button.dataset.menu, button));
      button.addEventListener("mouseenter", () => {
        if (S.menu && S.menu.name !== button.dataset.menu) openMenu(button.dataset.menu, button);
      });
    });

    document.addEventListener("mousedown", (event) => {
      if (!S.menu) return;
      if (S.menu.element.contains(event.target) || S.menu.anchor.contains(event.target)) return;
      closeMenu();
    });

    dom.editor.addEventListener("editor-change", onEditorInput);
    dom.editor.addEventListener("editor-selection", () => scheduleEditorMetrics(false));
    dom.editor.addEventListener("input", (event) => {
      if (event.target === dom.editor) onEditorInput();
    });
    dom.editor.addEventListener("paste", (event) => {
      const data = event.clipboardData;
      if (!data) return;
      const item = Array.from(data.items || [])
        .find((entry) => entry.kind === "file" && entry.type.startsWith("image/"));
      const file = item && item.getAsFile();
      if (!file) return;
      event.preventDefault();
      void insertImageAttachment(file).catch((error) => toast(textOf(error), "err"));
    });
    dom.editor.addEventListener("scroll", syncGutterScroll);
    dom.editor.addEventListener("click", updateStatus);
    dom.editor.addEventListener("keyup", updateStatus);
    dom.editor.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Tab") {
        event.preventDefault();
        const multiline = dom.editor.value
          .slice(dom.editor.selectionStart, dom.editor.selectionEnd)
          .includes("\n");
        if (multiline) indentSelection(event.shiftKey);
        else if (event.shiftKey) indentSelection(true);
        else insertText(indentUnit());
        return;
      }
      if (event.key === "Enter" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        handleEnter(event);
      }
    }, true);
    dom.editor.addEventListener(
      "wheel",
      (event) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        bumpFont(event.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );

    document.addEventListener("selectionchange", () => {
      if (dom.editor.hasFocus) scheduleEditorMetrics(false);
    });

    dom.findInput.addEventListener("input", () => findFromCaret());
    dom.findInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        findStep(event.shiftKey ? -1 : 1);
      }
    });
    dom.replaceInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) replaceAll();
        else replaceOne();
      }
    });
    $("find-next").addEventListener("click", () => findStep(1));
    $("find-prev").addEventListener("click", () => findStep(-1));
    $("find-close").addEventListener("click", closeFind);
    $("find-case").addEventListener("click", (event) => {
      event.currentTarget.classList.toggle("on");
      findFromCaret();
    });
    $("find-regex").addEventListener("click", (event) => {
      event.currentTarget.classList.toggle("on");
      findFromCaret();
    });
    $("replace-one").addEventListener("click", replaceOne);
    $("replace-all").addEventListener("click", replaceAll);

    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        void call("nSettings", {
          patch: { window: { width: window.innerWidth, height: window.innerHeight } },
        });
      }, 500);
    });

    window.addEventListener("blur", () => scheduleSession(true));
    window.addEventListener("focus", () => {
      clearTimeout(diskTimer);
      diskTimer = setTimeout(() => void checkDisk(), 350);
    });

    document.addEventListener("dragover", (event) => {
      event.preventDefault();
      document.body.classList.add("dragging");
    });
    document.addEventListener("dragleave", (event) => {
      if (!event.relatedTarget) document.body.classList.remove("dragging");
    });
    document.addEventListener("drop", (event) => {
      event.preventDefault();
      document.body.classList.remove("dragging");
      void handleDrop(event);
    });

    document.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (S.overlay) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = (event.key || "").toLowerCase();

      if (event.key === "Escape") {
        if (S.menu) {
          event.preventDefault();
          const anchor = S.menu.anchor;
          closeMenu();
          anchor.focus();
          return;
        }
        if (S.zen) {
          event.preventDefault();
          toggleZen();
        }
        return;
      }
      if (event.key === "F1") {
        event.preventDefault();
        showShortcuts();
        return;
      }
      if (event.key === "F3") {
        event.preventDefault();
        findStep(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === "F5") {
        event.preventDefault();
        return;
      }

      if (mod && !event.altKey) {
        if (key === ",") { event.preventDefault(); openSettings(); return; }
        if (key === "s") {
          event.preventDefault();
          void saveFlow(event.shiftKey);
          return;
        }
        if (key === "o") {
          event.preventDefault();
          void openFlow();
          return;
        }
        if (key === "n" || key === "w") {
          event.preventDefault();
          void newDoc();
          return;
        }
        if (key === "q") {
          event.preventDefault();
          void quitFlow();
          return;
        }
        if (key === "f" && !event.shiftKey) {
          event.preventDefault();
          openFind("find");
          return;
        }
        if (key === "h") {
          event.preventDefault();
          openFind("replace");
          return;
        }
        if (key === "g") {
          event.preventDefault();
          void gotoLine();
          return;
        }
        if (key === "p") {
          event.preventDefault();
          openPalette(event.shiftKey ? "command" : "open");
          return;
        }
        if (key === "b") {
          event.preventDefault();
          toggleSidebar();
          return;
        }
        if (key === "v" && event.shiftKey) {
          event.preventDefault();
          togglePreview();
          return;
        }
        if (key === "d" && event.shiftKey) {
          event.preventDefault();
          cycleTheme();
          return;
        }
        if (!event.shiftKey && (key === "=" || key === "+")) {
          event.preventDefault();
          bumpFont(1);
          return;
        }
        if (!event.shiftKey && key === "-") {
          event.preventDefault();
          bumpFont(-1);
          return;
        }
        if (!event.shiftKey && key === "0") {
          event.preventDefault();
          resetFont();
          return;
        }
      }

      if (event.altKey && key === "z") {
        event.preventDefault();
        toggleWrap();
      }
    });

    if (darkQuery) {
      const listener = () => {
        if (S.settings.theme === "auto") applyTheme();
      };
      if (typeof darkQuery.addEventListener === "function") darkQuery.addEventListener("change", listener);
      else if (darkQuery.addListener) darkQuery.addListener(listener);
    }

    if (narrowQuery) {
      const listener = () => {
        applyThemeAndChrome();
      };
      if (typeof narrowQuery.addEventListener === "function") narrowQuery.addEventListener("change", listener);
      else if (narrowQuery.addListener) narrowQuery.addListener(listener);
    }

    window.addEventListener("error", (event) => {
      void call("nLog", { level: "error", message: `${event.message} (${event.lineno})` });
    });
    window.addEventListener("unhandledrejection", (event) => {
      void call("nLog", { level: "error", message: `unhandled: ${textOf(event.reason)}` });
    });
  }

  async function handleDrop(event) {
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    if (file.type.startsWith("image/")) {
      try {
        await insertImageAttachment(file);
      } catch (error) {
        toast(textOf(error), "err");
      }
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast(t("dropTooLarge"), "err");
      return;
    }
    if (
      /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|7z|rar|exe|dll|msi|mp3|mp4|mov|avi|mkv|woff2?|ttf|otf)$/i.test(
        file.name,
      )
    ) {
      toast(t("dropBinary"), "err");
      return;
    }
    // WebView2 does not expose an absolute path on the DOM File object.
    // Never infer it from the name: two folders can contain the same filename.
    if (typeof file.path === "string" && isAbsoluteish(file.path)) {
      await openPath(file.path);
      return;
    }
    toast(t("dropChooseOriginal"));
    const picked = await fileDialog({ mode: "open", startDir: S.dir || S.settings.lastDir || null, name: file.name });
    if (picked) await openPath(picked.path);
  }

  async function init() {
    applyTheme();
    bindEvents();

    const ready = await call("nReady");
    if (!ready.ok) {
      fatal(ready.error);
      return;
    }

    S.app = ready.app || {};
    const customWindow = S.app.platform === "win32";
    document.body.classList.toggle("custom-window", customWindow);
    $("window-controls").hidden = !customWindow;
    S.places = ready.places || [];
    S.sep = S.app.sep || "\\";
    S.settings = Object.assign(defaultSettings(), ready.settings || {});
    S.recents = (S.settings.recents || []).slice();

    applyThemeAndChrome();
    renderRecents();
    updateCounts();

    await boot(ready.session, S.app.startupFile);
    const startup = { requested: S.app.startupFile || null, path: S.path, content: dom.editor.value };
    applyThemeAndChrome();
    renderPreview();
    focusEditor();

    if (window.__NISIO_SMOKE__) {
      await runSmoke(startup).catch((error) => call("nSmoke", { ok: false, error: error.stack || String(error) }));
    }
  }

  void init();
})();
