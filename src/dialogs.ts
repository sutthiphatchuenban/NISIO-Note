import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

export interface ChooseFileOptions {
  owner: Pointer | null;
  mode: "open" | "save";
  directory?: string | null;
  name?: string;
}

export type ChooseFileResult =
  | { ok: true; path: string | null }
  | { ok: false; error: string };

// OPENFILENAMEW, Windows x64 ABI. Padding is left zeroed.
const OFN = {
  size: 152,
  lStructSize: 0,
  hwndOwner: 8,
  hInstance: 16,
  lpstrFilter: 24,
  lpstrCustomFilter: 32,
  nMaxCustFilter: 40,
  nFilterIndex: 44,
  lpstrFile: 48,
  nMaxFile: 56,
  lpstrFileTitle: 64,
  nMaxFileTitle: 72,
  lpstrInitialDir: 80,
  lpstrTitle: 88,
  Flags: 96,
  nFileOffset: 100,
  nFileExtension: 102,
  lpstrDefExt: 104,
  lCustData: 112,
  lpfnHook: 120,
  lpTemplateName: 128,
  pvReserved: 136,
  dwReserved: 144,
  FlagsEx: 148,
} as const;

const OFN_OVERWRITEPROMPT = 0x00000002;
const OFN_NOCHANGEDIR = 0x00000008;
const OFN_PATHMUSTEXIST = 0x00000800;
const OFN_FILEMUSTEXIST = 0x00001000;
const OFN_EXPLORER = 0x00080000;
const MAX_FILE_CHARS = 32768;

/** Blocks until the native dialog closes; cancellation is a successful null path. */
export function chooseFile(opts: ChooseFileOptions): ChooseFileResult {
  if (process.platform !== "win32" || process.arch !== "x64") {
    return { ok: false, error: "Native file dialogs require Windows x64." };
  }

  try {
    if (opts.mode !== "open" && opts.mode !== "save") {
      return { ok: false, error: "Invalid file dialog mode." };
    }
    const name = opts.name ?? "";
    if (name.includes("\0") || opts.directory?.includes("\0")) {
      return { ok: false, error: "File dialog paths cannot contain null characters." };
    }
    if (name.length >= MAX_FILE_CHARS) {
      return { ok: false, error: "The initial file name is too long." };
    }

    const structure = Buffer.alloc(OFN.size);
    const file = Buffer.alloc(MAX_FILE_CHARS * 2);
    file.write(name, 0, "utf16le");
    const filter = Buffer.from("Text files (*.txt)\0*.txt\0All files (*.*)\0*.*\0\0", "utf16le");
    const directory = opts.directory ? Buffer.from(`${opts.directory}\0`, "utf16le") : null;
    const extension = Buffer.from("txt\0", "utf16le");
    // Raw pointers do not keep their backing buffers reachable by the GC.
    const buffers = [structure, file, filter, directory, extension];
    const view = new DataView(structure.buffer, structure.byteOffset, structure.byteLength);
    const pointer = (offset: number, value: Pointer | null) => {
      view.setBigUint64(offset, BigInt(value ?? 0), true);
    };

    view.setUint32(OFN.lStructSize, OFN.size, true);
    pointer(OFN.hwndOwner, opts.owner);
    pointer(OFN.lpstrFilter, ptr(filter));
    view.setUint32(OFN.nFilterIndex, opts.mode === "open" ? 2 : 1, true);
    pointer(OFN.lpstrFile, ptr(file));
    view.setUint32(OFN.nMaxFile, MAX_FILE_CHARS, true);
    pointer(OFN.lpstrInitialDir, directory ? ptr(directory) : null);
    pointer(OFN.lpstrDefExt, ptr(extension));
    view.setUint32(OFN.Flags,
      OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR |
      (opts.mode === "open" ? OFN_FILEMUSTEXIST : OFN_OVERWRITEPROMPT), true);

    const library = dlopen("comdlg32.dll", {
      GetOpenFileNameW: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetSaveFileNameW: { args: [FFIType.ptr], returns: FFIType.i32 },
      CommDlgExtendedError: { args: [], returns: FFIType.u32 },
    });
    try {
      const accepted = opts.mode === "open"
        ? library.symbols.GetOpenFileNameW(ptr(structure))
        : library.symbols.GetSaveFileNameW(ptr(structure));
      if (!accepted) {
        const error = library.symbols.CommDlgExtendedError();
        return error === 0
          ? { ok: true, path: null }
          : { ok: false, error: `Windows file dialog failed (CommDlgExtendedError: 0x${error.toString(16)}).` };
      }
      let end = 0;
      while (end < file.length && file.readUInt16LE(end) !== 0) end += 2;
      return { ok: true, path: file.toString("utf16le", 0, end) };
    } finally {
      // Access every buffer after the call so all native pointees remain live.
      for (const buffer of buffers) buffer?.subarray(0, 0);
      library.close();
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
