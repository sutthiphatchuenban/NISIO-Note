import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { assertExecutableIcons } from "./windows-icons.ts";

export const projectRoot = resolve(import.meta.dir, "..");
const cache = join(projectRoot, ".tmp", "installer-tools");
const compilerVersion = "7.1.1";
const compilerDir = join(cache, `inno-${compilerVersion}`);
const runtimePath = join(cache, "MicrosoftEdgeWebView2RuntimeInstallerX64.exe");
export const installerTestName = "NISIO Note (Installer Test)";
export const installerTestKey = "{F0BBE442-CC20-4983-BE92-29F6020AEAA7}.Test_is1";

function run(command: string[], timeout = 120000): void {
  const result = Bun.spawnSync(command, { cwd: projectRoot, stdout: "inherit", stderr: "inherit", windowsHide: true, timeout });
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed (exit ${result.exitCode}).`);
}

async function download(url: string, destination: string): Promise<void> {
  if (existsSync(destination)) return;
  console.log(`Downloading ${destination.split(/[\\/]/).at(-1)}...`);
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} (${url})`);
  const temporary = `${destination}.download`;
  await Bun.write(temporary, response);
  const bytes = await Bun.file(temporary).slice(0, 2).arrayBuffer();
  if (new Uint8Array(bytes)[0] !== 0x4d || new Uint8Array(bytes)[1] !== 0x5a) {
    throw new Error(`The download is not a Windows executable: ${url}`);
  }
  renameSync(temporary, destination);
}

function verifyPublisher(path: string, publisher: string): void {
  const encoded = Buffer.from(path, "utf16le").toString("base64");
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); `
    + `$s=Get-AuthenticodeSignature -LiteralPath $p; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch '${publisher}') `
    + `{ throw ('Invalid installer signature: ' + $s.Status + ' ' + $s.SignerCertificate.Subject) }`;
  run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
}

async function findCompiler(): Promise<string> {
  const candidates = [
    process.env.ISCC_PATH,
    Bun.which("ISCC.exe"),
    join(compilerDir, "ISCC.exe"),
    join(process.env.ProgramFiles || "C:\\Program Files", "Inno Setup 7", "ISCC.exe"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
    join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 7", "ISCC.exe"),
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  const bootstrap = join(cache, `innosetup-${compilerVersion}-x64.exe`);
  await download(`https://github.com/jrsoftware/issrc/releases/download/is-7_1_1/innosetup-${compilerVersion}-x64.exe`, bootstrap);
  verifyPublisher(bootstrap, "Pyrsys|Jordan Russell");
  console.log("Preparing a portable Inno Setup compiler in .tmp/installer-tools...");
  run([bootstrap, "/PORTABLE=1", "/CURRENTUSER", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/DIR=${compilerDir}`]);
  const compiler = join(compilerDir, "ISCC.exe");
  if (!existsSync(compiler)) throw new Error("Inno Setup compiler was not created. Set ISCC_PATH to your ISCC.exe.");
  return compiler;
}

export async function buildInstaller(test = false): Promise<string> {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build the x64 installer on Windows x64.");
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Installer requires a numeric major.minor.patch version.");
  if (!existsSync(join(projectRoot, "dist", "NISIO Note.exe"))) throw new Error("Run bun run build before packaging the installer.");
  assertExecutableIcons(join(projectRoot, "dist", "NISIO Note.exe"), join(projectRoot, "assets", "icon.ico"));
  mkdirSync(cache, { recursive: true });
  const compiler = await findCompiler();
  await download("https://go.microsoft.com/fwlink/?linkid=2124701", runtimePath);
  verifyPublisher(runtimePath, "Microsoft Corporation");
  const args = [compiler, `/DProjectRoot=${projectRoot}`, `/DAppVersion=${pkg.version}`, `/DRuntimeInstaller=${runtimePath}`];
  if (test) args.push("/DTestInstall=1");
  args.push(join(projectRoot, "installer", "NISIO-Note.iss"));
  run(args, 300000);
  const output = join(projectRoot, "dist", `NISIO-Note-Setup-${test ? "Test-" : ""}${pkg.version}-x64.exe`);
  assertExecutableIcons(output, join(projectRoot, "assets", "icon.ico"));
  console.log(`Installer ready: ${output} (${(statSync(output).size / 1024 / 1024).toFixed(1)} MiB)`);
  return output;
}

if (import.meta.main) await buildInstaller(process.argv.includes("--test"));
