import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDataDir } from "./paths.ts";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i;
const attachmentsDir = join(appDataDir, "Attachments");

type Failure = { ok: false; error: string; noImage?: true };
type SaveResult = { ok: true; id: string; url: string } | Failure;
type ReadResult = { ok: true; dataUrl: string } | Failure;

function failure(error: unknown): Failure {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

// Bindings must complete synchronously while the native webview loop is running.
export function saveImage(base64: string): SaveResult {
  try {
    if (typeof base64 !== "string" || !base64.length) return failure("Invalid image base64");
    if (base64.length > MAX_BASE64_LENGTH) return failure("Image exceeds 10 MiB");
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      return failure("Invalid image base64");
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > MAX_IMAGE_BYTES) return failure("Image exceeds 10 MiB");
    // Buffer's decoder is permissive; require canonical padding and pad bits too.
    if (bytes.toString("base64") !== base64) return failure("Invalid image base64");
    if (!isPng(bytes)) return failure("Image must be a PNG");

    mkdirSync(attachmentsDir, { recursive: true });
    const id = `${randomUUID()}.png`;
    writeFileSync(join(attachmentsDir, id), bytes, { flag: "wx" });
    return { ok: true, id, url: `nisio-asset:${id}` };
  } catch (error) {
    return failure(error);
  }
}

export function readImage(id: string): ReadResult {
  try {
    if (typeof id !== "string" || id.length !== 40 || !IMAGE_ID.test(id)) {
      return failure("Invalid attachment ID");
    }
    const fd = openSync(join(attachmentsDir, id), "r");
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return failure("Attachment is not a file");
      if (stat.size > MAX_IMAGE_BYTES) return failure("Image exceeds 10 MiB");
      // Bound the read even if the file grows after the size check.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > stat.size) return failure("Attachment changed while reading");
      bytes = buffer.subarray(0, length);
    } finally {
      closeSync(fd);
    }
    if (!isPng(bytes)) return failure("Image must be a PNG");
    return { ok: true, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
  } catch (error) {
    return failure(error);
  }
}

// No user input is interpolated into this command. Exit 3 means no clipboard image.
const READ_CLIPBOARD_IMAGE = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }
  $image = [System.Windows.Forms.Clipboard]::GetImage()
  if ($null -eq $image) { exit 3 }
  try {
    $stream = New-Object System.IO.MemoryStream
    try {
      $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      if ($stream.Length -gt 10485760) { throw 'Image exceeds 10 MiB' }
      [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
    } finally { $stream.Dispose() }
  } finally { $image.Dispose() }
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
`;

export function readClipboardImage(): SaveResult {
  if (process.platform !== "win32") return failure("unsupported");
  try {
    const result = spawnSync("powershell.exe", [
      "-STA", "-NoProfile", "-NonInteractive", "-Command", READ_CLIPBOARD_IMAGE,
    ], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 10000,
      maxBuffer: 15 * 1024 * 1024,
    });
    if (result.error) return failure(result.error);
    if (result.status === 3) {
      return { ok: false, error: "No image on clipboard", noImage: true };
    }
    if (result.status !== 0) {
      return failure(result.stderr?.trim() || "Could not read clipboard image");
    }
    return saveImage(result.stdout.trim());
  } catch (error) {
    return failure(error);
  }
}
