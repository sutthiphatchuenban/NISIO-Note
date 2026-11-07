import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { revealPath } from "../src/files.ts";

if (process.platform !== "win32") throw new Error("This integration check requires Windows Explorer.");
const root = mkdtempSync(join(tmpdir(), "nisio-shell-"));
const directory = join(root, "โฟลเดอร์ ทดสอบ, reveal");
mkdirSync(directory);
const file = join(directory, "โน้ต ทดสอบ, & (1).txt");
writeFileSync(file, "Explorer integration test");
function shellWindows(close = false): { folder: string; visible: boolean; selected: string[] }[] {
  const script = `
    $ErrorActionPreference = 'Stop'
    $shell = New-Object -ComObject Shell.Application
    $expected = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(directory, "utf16le").toString("base64")}'))
    $found = @()
    foreach ($window in @($shell.Windows())) {
      try {
        $folder = $window.Document.Folder.Self.Path
        if ($folder -eq $expected) {
          $selected = @($window.Document.SelectedItems() | ForEach-Object { $_.Path })
          $found += @{ folder = $folder; visible = [bool]$window.Visible; selected = $selected }
          ${close ? "$window.Quit()" : ""}
        }
      } catch { }
    }
    ConvertTo-Json -InputObject @($found) -Compress
  `;
  const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
    Buffer.from("[Console]::OutputEncoding = [Text.Encoding]::UTF8;" + script, "utf16le").toString("base64")], {
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString().replace(/^\uFEFF/, "").trim());
}

try {
  const selected = revealPath(file);
  if (!selected.ok) throw new Error(selected.error);
  let found: ReturnType<typeof shellWindows> = [];
  for (let i = 0; i < 20; i++) {
    found = shellWindows();
    if (found.some((window) => window.visible && window.selected.includes(file))) break;
    await Bun.sleep(250);
  }
  if (!found.some((window) => window.visible && window.selected.includes(file))) {
    throw new Error(`Explorer did not visibly select the file: ${JSON.stringify(found)}`);
  }
  const opened = revealPath(directory);
  if (!opened.ok) throw new Error(opened.error);
  await Bun.sleep(500);
  if (!shellWindows().some((window) => window.visible)) throw new Error("Folder window is not visible.");
  const missing = revealPath(join(root, "missing.txt"));
  if (missing.ok) throw new Error("A missing file incorrectly reported success.");
  console.log(JSON.stringify({ ok: true, unicodeSpacesCommas: true, fileSelected: true, folderVisible: true, missingRejected: true }));
} finally {
  shellWindows(true); // Only close Explorer windows for this unique fixture directory.
  await Bun.sleep(200);
  rmSync(root, { recursive: true, force: true });
}
