import { spawnSync } from "node:child_process";

let cachedFonts: string[] | null = null;

/** Enumerate installed families locally; never downloads fonts. */
export function installedFonts(): { ok: true; fonts: string[] } | { ok: false; error: string } {
  if (cachedFonts) return { ok: true, fonts: cachedFonts };
  if (process.platform !== "win32") {
    return { ok: false, error: "Installed font discovery currently supports Windows only." };
  }
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Drawing; $fonts = New-Object System.Drawing.Text.InstalledFontCollection; try { @($fonts.Families | ForEach-Object { $_.Name } | Sort-Object -Unique) | ConvertTo-Json -Compress } finally { $fonts.Dispose() }",
  ], { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    return { ok: false, error: "Could not read installed fonts. You can still enter a font family manually." };
  }
  try {
    const raw: unknown = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
    const names = Array.isArray(raw) ? raw : [raw];
    cachedFonts = names.filter((name): name is string => typeof name === "string" && !!name.trim());
    return { ok: true, fonts: cachedFonts };
  } catch {
    return { ok: false, error: "Windows returned an unreadable font list." };
  }
}
