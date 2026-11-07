import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readTextFile, revealPath, writeTextFile } from "../src/files.ts";
import { startupFile } from "../src/arguments.ts";

const root = mkdtempSync(join(tmpdir(), "nisio-regression-"));
process.env.NISIO_DATA_DIR = root;
const { appDataDir } = await import("../src/paths.ts");
const { saveSession, loadSession } = await import("../src/store.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("file integrity", () => {
  test("parse Explorer file paths without treating app flags as files", () => {
    const file = join(root, "ไฟล์ มี ช่องว่าง.txt");
    expect(startupFile(["--smoke", "--data-dir", root, "--open-file", file])).toBe(file);
    expect(startupFile(["--data-dir", root, file])).toBe(file);
    expect(startupFile(["--open-file=" + file])).toBe(file);
    expect(startupFile(["--smoke", "--data-dir", root])).toBeNull();
  });
  test("reveal rejects missing, empty and null-containing paths", () => {
    expect(revealPath(join(root, "does-not-exist.txt")).ok).toBe(false);
    expect(revealPath("").ok).toBe(false);
    expect(revealPath("invalid\0path").ok).toBe(false);
  });
  test("absolute data directory is respected", () => {
    expect(appDataDir).toBe(resolve(root));
  });

  test("Thai, emoji, CRLF and BOM round-trip without losing a content BOM", () => {
    const path = join(root, "unicode.txt");
    const content = "\uFEFFภาษาไทย 📝\nsecond line\n";
    expect(writeTextFile({ path, content, eol: "CRLF", bom: true }).ok).toBe(true);
    const result = readTextFile(path);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.file.content).toBe(content);
    expect(result.file.eol).toBe("CRLF");
    expect(result.file.bom).toBe(true);
  });

  test("invalid UTF-8 is rejected instead of silently corrupting text", () => {
    const path = join(root, "invalid.txt");
    writeFileSync(path, new Uint8Array([0x61, 0xc3, 0x28]));
    const result = readTextFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("UTF-8");
  });

  test("oversized UTF-8 save leaves the original file intact", () => {
    const path = join(root, "large.txt");
    writeFileSync(path, "original");
    const result = writeTextFile({ path, content: "ก".repeat(7 * 1024 * 1024) });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("original");
  });

  test("external modification is not overwritten", () => {
    const path = join(root, "conflict.txt");
    const saved = writeTextFile({ path, content: "before" });
    if (!saved.ok) throw new Error(saved.error);
    writeFileSync(path, "external edit");
    const modified = new Date(saved.file.mtime + 5000);
    utimesSync(path, modified, modified);
    expect(writeTextFile({ path, content: "my edit", expectedMtime: saved.file.mtime }).ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("external edit");
  });

  test("oversized recovery cannot leave an unrelated old snapshot", () => {
    const state = { path: null, dir: null, name: "old", content: "old snapshot", dirty: true,
      eol: "LF" as const, bom: false, mtime: 0, at: Date.now() };
    saveSession(state);
    expect(loadSession()?.content).toBe("old snapshot");
    saveSession({ ...state, content: "x".repeat(1_500_001) });
    expect(loadSession()).toBeNull();
  });
});
