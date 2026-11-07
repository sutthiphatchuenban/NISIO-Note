import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";

const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x0002;
const MAX_CLIPBOARD_BYTES = 64 * 1024 * 1024;

type Failure = { ok: false; error: string };
type ReadResult = { ok: true; text: string } | Failure;
type WriteResult = { ok: true } | Failure;

function loadLibraries() {
  const user32 = dlopen("user32.dll", {
    GetDesktopWindow: { args: [], returns: FFIType.ptr },
    OpenClipboard: { args: [FFIType.ptr], returns: FFIType.i32 },
    CloseClipboard: { args: [], returns: FFIType.i32 },
    IsClipboardFormatAvailable: { args: [FFIType.u32], returns: FFIType.i32 },
    GetClipboardData: { args: [FFIType.u32], returns: FFIType.ptr },
    EmptyClipboard: { args: [], returns: FFIType.i32 },
    SetClipboardData: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
  });
  try {
    const kernel32 = dlopen("kernel32.dll", {
      GlobalAlloc: { args: [FFIType.u32, FFIType.u64], returns: FFIType.ptr },
      GlobalLock: { args: [FFIType.ptr], returns: FFIType.ptr },
      GlobalUnlock: { args: [FFIType.ptr], returns: FFIType.i32 },
      GlobalSize: { args: [FFIType.ptr], returns: FFIType.u64 },
      GlobalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
    });
    return { user32, kernel32 };
  } catch (error) {
    user32.close();
    throw error;
  }
}

// Retain the DLL objects, not just their symbols, for the module's lifetime.
let libraries: ReturnType<typeof loadLibraries> | undefined;

function failure(error: unknown): Failure {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function readClipboard(): ReadResult {
  if (process.platform !== "win32") return { ok: false, error: "unsupported" };

  try {
    const { user32, kernel32 } = libraries ??= loadLibraries();
    const user = user32.symbols;
    const kernel = kernel32.symbols;
    if (!user.OpenClipboard(null)) return failure("OpenClipboard failed");
    let result: ReadResult;
    try {
      if (!user.IsClipboardFormatAvailable(CF_UNICODETEXT)) {
        return failure("Unicode text is not available on the clipboard");
      }
      const handle = user.GetClipboardData(CF_UNICODETEXT);
      if (!handle) return failure("GetClipboardData failed");
      const size = Number(kernel.GlobalSize(handle));
      if (!Number.isSafeInteger(size) || size < 2 || size > MAX_CLIPBOARD_BYTES) {
        return failure("Clipboard data has an invalid size or exceeds 64 MiB");
      }
      const address = kernel.GlobalLock(handle);
      if (!address) return failure("GlobalLock failed");
      let copy: Uint8Array;
      try {
        // Never retain a view of clipboard-owned memory after unlocking it.
        copy = new Uint8Array(new Uint8Array(toArrayBuffer(address, 0, size)));
      } finally {
        // Zero is also the normal success result when the lock count reaches zero.
        kernel.GlobalUnlock(handle);
      }
      let end = 0;
      while (end + 1 < copy.length && (copy[end] !== 0 || copy[end + 1] !== 0)) end += 2;
      if (end + 1 >= copy.length) return failure("Clipboard Unicode text is not null-terminated");
      result = { ok: true, text: Buffer.from(copy.buffer, copy.byteOffset, end).toString("utf16le") };
    } finally {
      if (!user.CloseClipboard()) throw new Error("CloseClipboard failed");
    }
    return result;
  } catch (error) {
    return failure(error);
  }
}

export function writeClipboard(text: string): WriteResult {
  if (process.platform !== "win32") return { ok: false, error: "unsupported" };

  try {
    if (typeof text !== "string") return failure("Clipboard text must be a string");
    if (text.length > MAX_CLIPBOARD_BYTES / 2 - 1) return failure("Clipboard text exceeds 64 MiB");
    if (text.includes("\0")) return failure("Clipboard text cannot contain null characters");
    const bytes = Buffer.from(`${text}\0`, "utf16le");
    const { user32, kernel32 } = libraries ??= loadLibraries();
    const user = user32.symbols;
    const kernel = kernel32.symbols;
    let handle = kernel.GlobalAlloc(GMEM_MOVEABLE, bytes.byteLength);
    if (!handle) return failure("GlobalAlloc failed");
    try {
      const address = kernel.GlobalLock(handle);
      if (!address) return failure("GlobalLock failed");
      try {
        new Uint8Array(toArrayBuffer(address, 0, bytes.byteLength)).set(bytes);
      } finally {
        kernel.GlobalUnlock(handle);
      }
      // A null owner makes SetClipboardData fail after EmptyClipboard. This
      // module has no application HWND, so use the always-present desktop HWND.
      const owner = user.GetDesktopWindow();
      if (!owner) return failure("GetDesktopWindow failed");
      if (!user.OpenClipboard(owner)) return failure("OpenClipboard failed");
      try {
        if (!user.EmptyClipboard()) return failure("EmptyClipboard failed");
        if (!user.SetClipboardData(CF_UNICODETEXT, handle)) return failure("SetClipboardData failed");
        handle = null; // Windows owns the allocation only after a successful set.
      } finally {
        if (!user.CloseClipboard()) throw new Error("CloseClipboard failed");
      }
    } finally {
      if (handle && kernel.GlobalFree(handle)) throw new Error("GlobalFree failed");
    }
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
