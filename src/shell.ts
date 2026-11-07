import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { dirname } from "node:path";

function showExplorerWindow(folder: string, selectedFile?: string): void {
  // Explorer can reuse a hidden window created by older app versions. Shell
  // success alone does not mean it is visible; activate the matching Shell view.
  const encodedPath = Buffer.from(folder, "utf16le").toString("base64");
  const encodedFile = Buffer.from(selectedFile || "", "utf16le").toString("base64");
  const script = `
    $ErrorActionPreference = 'Stop'
    $folder = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))
    $file = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedFile}'))
    $shell = New-Object -ComObject Shell.Application
    for ($i = 0; $i -lt 40; $i++) {
      foreach ($window in @($shell.Windows())) {
        try {
          if ($window.Document.Folder.Self.Path.TrimEnd([char]92) -eq $folder.TrimEnd([char]92)) {
            if ($file -and (@($window.Document.SelectedItems() | ForEach-Object { $_.Path }) -notcontains $file)) { continue }
            $window.Visible = $true
            [Console]::Write([string]$window.HWND)
            exit 0
          }
        } catch { }
      }
      Start-Sleep -Milliseconds 100
    }
    [Console]::Error.Write('Explorer did not show the requested folder.')
    exit 1
  `;
  const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], {
    stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 10000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "Could not show Windows Explorer.");
  const hwnd = Number(result.stdout.toString().trim());
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error("Explorer did not return a window handle.");
  const user = dlopen("user32.dll", {
    ShowWindowAsync: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    SetForegroundWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  try {
    user.symbols.ShowWindowAsync(hwnd as Pointer, 9); // SW_RESTORE, including minimized windows.
    user.symbols.SetForegroundWindow(hwnd as Pointer);
  } finally {
    user.close();
  }
}

/** Synchronous Shell calls also work while webview.run() owns the event loop. */
export function revealInWindows(path: string, directory: boolean): void {
  if (path.includes("\0")) throw new Error("File paths cannot contain null characters.");
  const shell = dlopen("shell32.dll", {
    ShellExecuteW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32],
      returns: FFIType.i64,
    },
    SHParseDisplayName: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    SHOpenFolderAndSelectItems: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
  });
  try {
    const ole = dlopen("ole32.dll", {
      CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      CoUninitialize: { args: [], returns: FFIType.void },
      CoTaskMemFree: { args: [FFIType.ptr], returns: FFIType.void },
    });
    const name = Buffer.from(`${path}\0`, "utf16le");
    const operation = Buffer.from("open\0", "utf16le");
    const output = Buffer.alloc(8);
    let pidl: Pointer | null = null;
    let uninitialize = false;
    const check = (result: number, action: string) => {
      if (result < 0) throw new Error(`${action} failed (HRESULT 0x${(result >>> 0).toString(16)}).`);
    };
    try {
      const initialized = ole.symbols.CoInitializeEx(null, 2); // COINIT_APARTMENTTHREADED
      // An existing apartment is valid too; don't uninitialize one we don't own.
      if ((initialized >>> 0) !== 0x80010106) check(initialized, "Initialize Windows Shell");
      uninitialize = initialized >= 0;
      if (directory) {
        // SW_SHOWNORMAL, never SW_HIDE. Let Windows use its registered folder handler.
        const result = Number(shell.symbols.ShellExecuteW(null, ptr(operation), ptr(name), null, null, 1));
        if (result <= 32) throw new Error(`Could not open the folder in Windows (ShellExecute error ${result}).`);
      } else {
        check(shell.symbols.SHParseDisplayName(ptr(name), null, ptr(output), 0, null), "Locate file in Windows Shell");
        pidl = Number(output.readBigUInt64LE()) as Pointer;
        if (!pidl) throw new Error("Windows Shell could not locate that file.");
        // cidl=0: open the parent of this absolute item and select the item.
        check(shell.symbols.SHOpenFolderAndSelectItems(pidl, 0, null, 0), "Show file in Explorer");
      }
    } finally {
      if (pidl) ole.symbols.CoTaskMemFree(pidl);
      if (uninitialize) ole.symbols.CoUninitialize();
      // Native pointers do not root their buffers across the FFI call.
      for (const buffer of [name, operation, output]) buffer.subarray(0, 0);
      ole.close();
    }
  } finally {
    shell.close();
  }
  showExplorerWindow(directory ? path : dirname(path), directory ? undefined : path);
}
