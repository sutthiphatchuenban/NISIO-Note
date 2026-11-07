import { copyFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

type Resource = { type: number; name: number | string; lang: number; data: Buffer };

// Read the PE resource tree directly, rather than trusting Explorer's icon cache.
function resources(bytes: Buffer): Resource[] {
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString("ascii", pe, pe + 4) !== "PE\0\0") throw new Error("Not a PE executable");
  const optional = pe + 24;
  const directories = optional + (bytes.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const sections = optional + bytes.readUInt16LE(pe + 20);
  const offsetFor = (rva: number) => {
    for (let i = 0; i < bytes.readUInt16LE(pe + 6); i++) {
      const section = sections + i * 40;
      const start = bytes.readUInt32LE(section + 12);
      const size = bytes.readUInt32LE(section + 16);
      if (rva >= start && rva < start + size) return bytes.readUInt32LE(section + 20) + rva - start;
    }
    throw new Error(`Resource RVA is outside the executable: ${rva}`);
  };
  const root = offsetFor(bytes.readUInt32LE(directories + 16));
  const result: Resource[] = [];
  function walk(relative: number, keys: (number | string)[]) {
    const at = root + relative;
    const count = bytes.readUInt16LE(at + 12) + bytes.readUInt16LE(at + 14);
    for (let i = 0; i < count; i++) {
      const entry = at + 16 + i * 8;
      const id = bytes.readUInt32LE(entry);
      const nameAt = root + (id & 0x7fffffff);
      const name = id & 0x80000000
        ? bytes.toString("utf16le", nameAt + 2, nameAt + 2 + bytes.readUInt16LE(nameAt) * 2) : id;
      const next = bytes.readUInt32LE(entry + 4);
      const path = [...keys, name];
      if (path[0] !== 3 && path[0] !== 14) continue;
      if (next & 0x80000000) walk(next & 0x7fffffff, path);
      else {
        if (path.length !== 3 || typeof path[2] !== "number") throw new Error("Invalid icon resource path");
        const dataAt = root + next;
        const offset = offsetFor(bytes.readUInt32LE(dataAt));
        const size = bytes.readUInt32LE(dataAt + 4);
        const data = bytes.subarray(offset, offset + size);
        if (data.length !== size) throw new Error("Truncated icon resource");
        result.push({ type: path[0] as number, name: path[1]!, lang: path[2], data });
      }
    }
  }
  walk(0, []);
  return result;
}

function iconFrames(path: string) {
  const ico = readFileSync(path);
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error("Not an ICO file");
  return Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
    const at = 6 + i * 16;
    const offset = ico.readUInt32LE(at + 12);
    const size = ico.readUInt32LE(at + 8);
    const data = ico.subarray(offset, offset + size);
    if (data.length !== size) throw new Error("Truncated ICO frame");
    return { entry: ico.subarray(at, at + 12), data };
  });
}

function expectedGroups(exe: string, icon: string) {
  const entries = resources(readFileSync(exe));
  const frames = iconFrames(icon);
  const groups = entries.filter((entry) => entry.type === 14);
  if (!groups.length) throw new Error(`No icon groups in ${exe}`);
  return groups.map((group) => {
    const data = Buffer.alloc(6 + frames.length * 14);
    data.writeUInt16LE(1, 2);
    data.writeUInt16LE(frames.length, 4);
    frames.forEach((frame, i) => {
      const image = entries.find((entry) => entry.type === 3 && entry.lang === group.lang
        && typeof entry.name === "number" && entry.data.equals(frame.data));
      if (!image || typeof image.name !== "number" || image.name > 65535) {
        throw new Error(`Missing native-resolution icon image ${frame.entry[0] || 256}px in ${exe}`);
      }
      frame.entry.copy(data, 6 + i * 14);
      data.writeUInt16LE(image.name, 6 + i * 14 + 12);
    });
    return { ...group, expected: data };
  });
}

export function assertExecutableIcons(exe: string, icon: string): void {
  const groups = expectedGroups(exe, icon);
  for (const group of groups) {
    if (!group.data.equals(group.expected)) {
      throw new Error(`Invalid icon directory ${JSON.stringify(group.name)} (language ${group.lang}) in ${exe}: `
        + "dimensions, byte lengths or image IDs do not match the source ICO. Run bun run build.");
    }
  }
  console.log(`Verified ${groups.length} icon group(s), all ${iconFrames(icon).length} sizes: ${exe}`);
}

// Bun can leave its original named icon group pointing at image #1 after
// replacing that image with our 16px frame. It also leaves stale byte lengths
// for larger DIB frames. Rebuild *every* group using the actual embedded images.
// References: https://devblogs.microsoft.com/oldnewthing/20120720-00/?p=7083
// https://learn.microsoft.com/en-us/windows/win32/menurc/using-resources
export function repairExecutableIcons(exe: string, icon: string): void {
  if (process.platform !== "win32") throw new Error("Icon resource repair requires Windows");
  const groups = expectedGroups(exe, icon);
  const temporary = `${exe}.icons-${process.pid}.tmp`;
  copyFileSync(exe, temporary);
  const kernel = dlopen("kernel32.dll", {
    BeginUpdateResourceW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    UpdateResourceW: { args: [FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.u16, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    EndUpdateResourceW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  let handle: Pointer | null = null;
  const buffers: Buffer[] = [Buffer.from(`${resolve(temporary)}\0`, "utf16le")];
  try {
    handle = kernel.symbols.BeginUpdateResourceW(ptr(buffers[0]!), 0) as Pointer | null;
    if (!handle) throw new Error(`BeginUpdateResourceW: ${kernel.symbols.GetLastError()}`);
    for (const group of groups) {
      buffers.push(group.expected);
      let name: number;
      if (typeof group.name === "string") {
        const text = Buffer.from(`${group.name}\0`, "utf16le");
        buffers.push(text);
        name = Number(ptr(text));
      } else name = group.name;
      if (!kernel.symbols.UpdateResourceW(handle, 14, name, group.lang, ptr(group.expected), group.expected.length)) {
        throw new Error(`UpdateResourceW: ${kernel.symbols.GetLastError()}`);
      }
    }
    const saved = kernel.symbols.EndUpdateResourceW(handle, 0);
    handle = null;
    if (!saved) throw new Error(`EndUpdateResourceW: ${kernel.symbols.GetLastError()}`);
    assertExecutableIcons(temporary, icon);
    renameSync(temporary, exe);
  } finally {
    if (handle) kernel.symbols.EndUpdateResourceW(handle, 1);
    // Keep UTF-16 pointees alive across all native calls.
    for (const buffer of buffers) buffer.subarray(0, 0);
    kernel.close();
    try { unlinkSync(temporary); } catch { /* Already renamed. */ }
  }
}

if (import.meta.main) {
  const exe = process.argv[2] || "dist/NISIO Note.exe";
  const icon = process.argv[3] || "assets/icon.ico";
  if (process.argv.includes("--check")) assertExecutableIcons(exe, icon);
  else repairExecutableIcons(exe, icon);
}
