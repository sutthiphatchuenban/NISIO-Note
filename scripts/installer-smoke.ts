import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import pkg from "../package.json";
import { buildInstaller, installerTestKey, installerTestName, projectRoot } from "./build-installer.ts";
import { assertExecutableIcons } from "./windows-icons.ts";

if (process.platform !== "win32") throw new Error("Installer smoke test requires Windows.");
const root = mkdtempSync(join(projectRoot, ".tmp", "installer-smoke-"));
const installDir = join(root, "ติดตั้ง ทดสอบ", "NISIO Note");
const dataDir = join(root, "preserved-note-data");
mkdirSync(dataDir);
const preserved = join(dataDir, "my-note.txt");
writeFileSync(preserved, "โน้ตต้องอยู่หลังถอนการติดตั้ง");

function powershell(script: string): unknown {
  const code = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " + script;
  const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(code, "utf16le").toString("base64")], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString().replace(/^\uFEFF/, "").trim());
}

type Installation = { registered: boolean; directory: string; version: string; shortcut: string; desktop: string; target: string };
function installation(): Installation {
  const key = ["HKCU:", "Software", "Microsoft", "Windows", "CurrentVersion", "Uninstall", installerTestKey].join("\\");
  return powershell(String.raw`
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface INisioShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr data, uint flags);
}
public static class NisioShortcutTarget {
  public static string Read(string path) {
    object link = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
    try {
      ((IPersistFile)link).Load(path, 0);
      StringBuilder result = new StringBuilder(32768);
      ((INisioShellLinkW)link).GetPath(result, result.Capacity, IntPtr.Zero, 0);
      return result.ToString();
    } finally { Marshal.FinalReleaseComObject(link); }
  }
}
'@
    $key = '${key}'
    $registered = Test-Path -LiteralPath $key
    $entry = if ($registered) { Get-ItemProperty -LiteralPath $key } else { $null }
    $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) '${installerTestName}.lnk'
    $desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) '${installerTestName}.lnk'
    $target = if (Test-Path -LiteralPath $shortcut) { [NisioShortcutTarget]::Read($shortcut) } else { '' }
    @{ registered = [bool]$registered; directory = [string]$entry.InstallLocation; version = [string]$entry.DisplayVersion;
       shortcut = $shortcut; desktop = $desktop; target = $target } | ConvertTo-Json -Compress
  `) as Installation;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function execute(file: string, args: string[]): { stdout: string } {
  const result = Bun.spawnSync([file, ...args], { cwd: projectRoot, stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 180000 });
  if (result.exitCode !== 0) throw new Error(`${file} exited ${result.exitCode}: ${result.stderr.toString()} ${result.stdout.toString()}`);
  return { stdout: result.stdout.toString() };
}

const binary = join(installDir, "NISIO Note Test.exe");
const uninstaller = join(installDir, "unins000.exe");
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const existing = installation();
assert(!existing.registered && !existsSync(existing.shortcut) && !existsSync(existing.desktop), "A previous installer-test installation exists; remove it before testing.");
const setup = await buildInstaller(true);
let uninstallAttempted = false;
try {
  execute(setup, ["/CURRENTUSER", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/DIR=${installDir}`,
    "/TASKS=desktopicon", `/LOG=${join(root, "install.log")}`]);
  assert(existsSync(binary) && existsSync(uninstaller), "Installation did not create the executable/uninstaller.");
  const registered = installation();
  assert(registered.registered && registered.version === pkg.version, "Installed app is not correctly registered for uninstall.");
  assert(registered.directory.replace(/[\\/]+$/, "") === installDir, "The chosen install directory was not respected.");
  const shortcutTarget = registered.target.replace(/^\\\\\?\\/, "");
  assert(shortcutTarget.toLowerCase() === binary.toLowerCase(), `Start menu shortcut points to the wrong executable: ${JSON.stringify(registered.target)} instead of ${JSON.stringify(binary)}`);
  assert(existsSync(registered.desktop), "Desktop shortcut was not created.");
  assert(hash(binary) === hash(join(projectRoot, "dist", "NISIO Note.exe")), "Installed binary differs from the built app.");
  assertExecutableIcons(binary, join(projectRoot, "assets", "icon.ico"));

  const smoke = execute(binary, ["--smoke", "--data-dir", dataDir]);
  const report = JSON.parse(smoke.stdout) as { ok: boolean; failed: string[] };
  assert(report.ok, `Installed app smoke failed: ${report.failed.join(", ")}`);
  const openWith = powershell(String.raw`
    $base = 'HKCU:\Software\Classes'
    $app = Join-Path $base 'Applications\NISIO Note Test.exe'
    $prog = Join-Path $base 'NISIO.Note.Test'
    $command = (Get-Item -LiteralPath (Join-Path $app 'shell\open\command')).GetValue('')
    $selected = (Get-Item -LiteralPath (Join-Path $base '.txt\OpenWithProgids')).GetValueNames() -contains 'NISIO.Note.Test'
    @{ command = $command; txt = $selected; md = ((Get-Item -LiteralPath (Join-Path $base '.md\OpenWithProgids')).GetValueNames() -contains 'NISIO.Note.Test');
       prog = (Test-Path -LiteralPath $prog) } | ConvertTo-Json -Compress
  `) as { command: string; txt: boolean; md: boolean; prog: boolean };
  assert(openWith.txt && openWith.md && openWith.prog, `Open with registration is missing: ${JSON.stringify(openWith)}`);
  assert(openWith.command === `"${binary}" --open-file "%1"`, `Open with command is incorrect: ${openWith.command}`);
  const launchDir = join(root, "open-with-data");
  const file = join(root, "เอกสาร ทดสอบ.txt");
  const contents = "เปิดจาก Explorer ภาษาไทย\nsecond line";
  writeFileSync(file, contents);
  const opened = JSON.parse(execute(binary, ["--smoke", "--data-dir", launchDir, "--open-file", file]).stdout) as
    { ok: boolean; startup: { requested: string; path: string; content: string } };
  assert(opened.ok && opened.startup.path === file && opened.startup.content === contents,
    `Open with did not load the requested file: ${JSON.stringify(opened.startup)}`);
  // Running Setup again must keep the chosen directory and the user's data.
  execute(setup, ["/CURRENTUSER", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/LOG=${join(root, "upgrade.log")}`]);
  assert(installation().directory.replace(/[\\/]+$/, "") === installDir, "Reinstallation lost the chosen directory.");
  assert(readFileSync(preserved, "utf8") === "โน้ตต้องอยู่หลังถอนการติดตั้ง", "Reinstallation changed user data.");

  execute(uninstaller, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/LOG=${join(root, "uninstall.log")}`]);
  uninstallAttempted = true;
  for (let i = 0; i < 50 && existsSync(binary); i++) await Bun.sleep(100);
  assert(!existsSync(binary), "Uninstall left the app executable behind.");
  const after = installation();
  assert(!after.registered && !existsSync(after.shortcut) && !existsSync(after.desktop), "Uninstall left registry entries or shortcuts behind.");
  const associationRemoved = powershell(String.raw`
    $base = 'HKCU:\Software\Classes'
    $key = Join-Path $base '.txt\OpenWithProgids'
    $names = if (Test-Path -LiteralPath $key) { (Get-Item -LiteralPath $key).GetValueNames() } else { @() }
    @{ removed = (-not (Test-Path -LiteralPath (Join-Path $base 'Applications\NISIO Note Test.exe'))) -and
       (-not (Test-Path -LiteralPath (Join-Path $base 'NISIO.Note.Test'))) -and ($names -notcontains 'NISIO.Note.Test') } | ConvertTo-Json -Compress
  `) as { removed: boolean };
  assert(associationRemoved.removed, "Uninstall left Open with registration behind.");
  assert(readFileSync(preserved, "utf8") === "โน้ตต้องอยู่หลังถอนการติดตั้ง", "Uninstall deleted user notes.");
  console.log(JSON.stringify({ ok: true, customUnicodeDirectory: true, shortcuts: true, uninstallRegistration: true,
    installedAppSmoke: true, openWith: true, uninstallRemovesOpenWith: true, reinstallPreservesLocation: true, uninstall: true, notesPreserved: true, logs: root }, null, 2));
} finally {
  if (!uninstallAttempted && existsSync(uninstaller)) {
    execute(uninstaller, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]);
  }
  // Keep test logs in .tmp; the production installer uses a separate AppId.
  rmSync(setup, { force: true });
}
