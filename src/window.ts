import { dlopen, FFIType, JSCallback, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import type { Webview } from "webview-bun";

const GWL_STYLE = -16;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_SYSMENU = 0x00080000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const SWP_FRAMECHANGED = 0x0020;
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SW_MINIMIZE = 6;
const SW_MAXIMIZE = 3;
const SW_RESTORE = 9;
const WM_NCLBUTTONDOWN = 0x00a1;
const HTCAPTION = 2;
const HTLEFT = 10;
const HTRIGHT = 11;
const HTTOP = 12;
const HTTOPLEFT = 13;
const HTTOPRIGHT = 14;
const HTBOTTOM = 15;
const HTBOTTOMLEFT = 16;
const HTBOTTOMRIGHT = 17;
const RESIZE_EDGES: Record<string, number> = {
  left: HTLEFT,
  right: HTRIGHT,
  top: HTTOP,
  bottom: HTBOTTOM,
  "top-left": HTTOPLEFT,
  "top-right": HTTOPRIGHT,
  "bottom-left": HTBOTTOMLEFT,
  "bottom-right": HTBOTTOMRIGHT,
};
const MIN_WINDOW_WIDTH = 640;
const MIN_WINDOW_HEIGHT = 420;
const DWMWA_NCRENDERING_POLICY = 2;
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMNCRP_DISABLED = 2;
const DWMWCP_DONOTROUND = 1;
const WM_SYSCOMMAND = 0x0112;
const SC_CLOSE = 0xf060;
const SM_CXDOUBLECLK = 36;
const SM_CYDOUBLECLK = 37;
const TPM_RETURNCMD = 0x0100;
const TPM_RIGHTBUTTON = 0x0002;

// Native code holds only a function pointer, not a GC root. Keep callbacks and
// their DLLs alive even after NCDESTROY; never free a trampoline on its own stack.
const nativeSubclasses = new Set<object>();
const WM_GETMINMAXINFO = 0x0024;
const WM_NCCALCSIZE = 0x0083;
const WM_NCDESTROY = 0x0082;
const MONITOR_DEFAULTTONEAREST = 2;

type WindowAction = "minimize" | "maximize" | "close" | "drag" | "resize" | "systemMenu" | "status";

/** Call after creating the webview and before view.run(). */
export function setupWindow(view: Webview): void {
  if (process.platform !== "win32") {
    view.bind("nWindow", () => ({ ok: false as const, error: "unsupported" }));
    return;
  }

  const hwnd = (view as Webview & { readonly unsafeWindowHandle: Pointer | null })
    .unsafeWindowHandle;
  if (!hwnd) throw new Error("Cannot configure titlebar: native window handle is unavailable");

  // Keep the library alive for the lifetime of the bound callback.
  const user32 = dlopen("user32.dll", {
    GetWindowLongW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    SetWindowLongW: {
      args: [FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    SetWindowPos: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32],
      returns: FFIType.i32,
    },
    MonitorFromWindow: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
    GetMonitorInfoW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    IsZoomed: { args: [FFIType.ptr], returns: FFIType.i32 },
    ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    ReleaseCapture: { args: [], returns: FFIType.i32 },
    PostMessageW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64],
      returns: FFIType.i32,
    },
    GetMessageTime: { args: [], returns: FFIType.i32 },
    GetDoubleClickTime: { args: [], returns: FFIType.u32 },
    GetCursorPos: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
    GetSystemMenu: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    TrackPopupMenu: {
      args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32,
    },
  });

  // SUBCLASSPROC requires synchronous results on the window's owning thread.
  // Do not use threadsafe callbacks: dispatching asynchronously cannot return LRESULT.
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error("Cannot configure titlebar: native subclass requires 64-bit Windows");
  }
  const kernel32 = dlopen("kernel32.dll", {
    GetCurrentThreadId: { args: [], returns: FFIType.u32 },
  });
  if (user32.symbols.GetWindowThreadProcessId(hwnd, null) !== kernel32.symbols.GetCurrentThreadId()) {
    kernel32.close();
    throw new Error("Cannot configure titlebar: window belongs to another thread");
  }
  kernel32.close();
  const comctl32 = dlopen("comctl32.dll", {
    SetWindowSubclass: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.i32,
    },
    RemoveWindowSubclass: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32,
    },
    DefSubclassProc: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64,
    },
  });
  const subclass = new JSCallback((window, message, wParam, lParam, id) => {
    if (message === WM_GETMINMAXINFO) {
      // Preserve the native tracking limits before overriding maximized bounds.
      const result = comctl32.symbols.DefSubclassProc(window, message, wParam, lParam);
      const monitor = user32.symbols.MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
      const info = new Int32Array(10); // MONITORINFO: cbSize, rcMonitor, rcWork, flags
      info[0] = info.byteLength;
      if (monitor && user32.symbols.GetMonitorInfoW(monitor, ptr(info))) {
        const limits = new Int32Array(toArrayBuffer(Number(lParam) as Pointer, 0, 40));
        // MINMAXINFO uses monitor-relative position, not screen coordinates.
        limits[2] = info[7]! - info[5]!;
        limits[3] = info[8]! - info[6]!;
        limits[4] = info[5]! - info[1]!;
        limits[5] = info[6]! - info[2]!;
        limits[6] = MIN_WINDOW_WIDTH;
        limits[7] = MIN_WINDOW_HEIGHT;
      }
      return result;
    }
    if (message === WM_NCCALCSIZE && wParam !== 0 && wParam !== 0n) {
      // The entire proposed window is client area. Maximized outer bounds are
      // set above; shrinking only the client leaves an uncovered native strip.
      return 0;
    }
    if (message === WM_NCDESTROY) {
      comctl32.symbols.RemoveWindowSubclass(window, subclass.ptr, id);
    }
    return comctl32.symbols.DefSubclassProc(window, message, wParam, lParam);
  }, {
    args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64, FFIType.u64, FFIType.u64],
    returns: FFIType.i64,
  });
  if (!comctl32.symbols.SetWindowSubclass(hwnd, subclass.ptr, 1, 0)) {
    subclass.close();
    comctl32.close();
    throw new Error("Cannot configure titlebar: SetWindowSubclass failed");
  }
  nativeSubclasses.add({ subclass, comctl32, user32 });

  const style = user32.symbols.GetWindowLongW(hwnd, GWL_STYLE);
  const framelessStyle = (style & ~WS_CAPTION)
    | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
  user32.symbols.SetWindowLongW(hwnd, GWL_STYLE, framelessStyle);
  if (user32.symbols.GetWindowLongW(hwnd, GWL_STYLE) !== framelessStyle) {
    throw new Error("Cannot configure titlebar: SetWindowLongW did not apply the window style");
  }
  if (!user32.symbols.SetWindowPos(
    hwnd, null, 0, 0, 0, 0,
    SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
  )) {
    throw new Error("Cannot configure titlebar: SetWindowPos failed to refresh the frame");
  }

  // Windows 11 draws rounded corners and a drop shadow for windows that keep a
  // resize frame. The custom titlebar is meant to sit flush, so opt out of both
  // to match the maximized look. Older Windows versions reject the attributes.
  const dwmapi = dlopen("dwmapi.dll", {
    DwmSetWindowAttribute: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
  });
  const cornerPreference = new Int32Array([DWMWCP_DONOTROUND]);
  dwmapi.symbols.DwmSetWindowAttribute(
    hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ptr(cornerPreference), cornerPreference.byteLength,
  );
  const ncRendering = new Int32Array([DWMNCRP_DISABLED]);
  dwmapi.symbols.DwmSetWindowAttribute(
    hwnd, DWMWA_NCRENDERING_POLICY, ptr(ncRendering), ncRendering.byteLength,
  );
  dwmapi.close();

  const cursor = new Int32Array(2);
  let lastDragPress: { time: number; x: number; y: number } | null = null;
  const toggleMaximize = () => user32.symbols.ShowWindow(
    hwnd, user32.symbols.IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE,
  );

  view.bind("nWindow", (payload: { action?: WindowAction; edge?: string } | null = {}) => {
    switch (payload?.action) {
      case "status":
        return {
          ok: true as const,
          maximized: !!user32.symbols.IsZoomed(hwnd),
          frameless: !(user32.symbols.GetWindowLongW(hwnd, GWL_STYLE) & WS_CAPTION),
        };
      case "minimize":
        user32.symbols.ShowWindow(hwnd, SW_MINIMIZE);
        break;
      case "maximize":
        lastDragPress = null;
        toggleMaximize();
        break;
      case "drag": {
        if (!user32.symbols.GetCursorPos(ptr(cursor))) {
          lastDragPress = null;
          return { ok: false as const, error: "GetCursorPos failed" };
        }
        const x = cursor[0]!;
        const y = cursor[1]!;
        const time = user32.symbols.GetMessageTime() >>> 0;
        // Unsigned subtraction also handles the native message clock wrapping.
        const doubleClick = lastDragPress !== null
          && ((time - lastDragPress.time) >>> 0) <= user32.symbols.GetDoubleClickTime()
          && Math.abs(x - lastDragPress.x) < user32.symbols.GetSystemMetrics(SM_CXDOUBLECLK) / 2
          && Math.abs(y - lastDragPress.y) < user32.symbols.GetSystemMetrics(SM_CYDOUBLECLK) / 2;
        lastDragPress = doubleClick ? null : { time, x, y };
        if (doubleClick) {
          toggleMaximize();
          break;
        }
        user32.symbols.ReleaseCapture();
        // Post so the native move loop starts only after this Bun callback returns.
        // MAKELPARAM packs signed screen coordinates into two 16-bit words.
        const position = ((y & 0xffff) << 16) | (x & 0xffff);
        if (!user32.symbols.PostMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, position)) {
          lastDragPress = null;
          return { ok: false as const, error: "Cannot post window drag" };
        }
        break;
      }
      case "resize": {
        if (user32.symbols.IsZoomed(hwnd)) break;
        const hit = RESIZE_EDGES[payload?.edge ?? ""];
        if (!hit) return { ok: false as const, error: "Unknown resize edge" };
        if (!user32.symbols.GetCursorPos(ptr(cursor))) {
          return { ok: false as const, error: "GetCursorPos failed" };
        }
        user32.symbols.ReleaseCapture();
        // Post so the native sizing loop starts only after this Bun callback returns.
        const position = ((cursor[1]! & 0xffff) << 16) | (cursor[0]! & 0xffff);
        if (!user32.symbols.PostMessageW(hwnd, WM_NCLBUTTONDOWN, hit, position)) {
          return { ok: false as const, error: "Cannot post window resize" };
        }
        break;
      }
      case "systemMenu": {
        lastDragPress = null;
        if (!user32.symbols.GetCursorPos(ptr(cursor))) {
          return { ok: false as const, error: "GetCursorPos failed" };
        }
        const menu = user32.symbols.GetSystemMenu(hwnd, 0);
        if (!menu) return { ok: false as const, error: "GetSystemMenu failed" };
        const command = user32.symbols.TrackPopupMenu(
          menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, cursor[0]!, cursor[1]!, 0, hwnd, null,
        );
        // Preserve the same unsaved-changes guard as the explicit close action.
        if (command === SC_CLOSE) {
          return { ok: true as const, closeRequested: true };
        }
        if (command && !user32.symbols.PostMessageW(hwnd, WM_SYSCOMMAND, command, 0)) {
          return { ok: false as const, error: "Cannot post system menu command" };
        }
        break;
      }
      case "close":
        // Never bypass the UI's unsaved-changes guard by destroying the window.
        return { ok: true as const, closeRequested: true };
      default:
        return { ok: false as const, error: "Unknown window action" };
    }
    return { ok: true as const, maximized: !!user32.symbols.IsZoomed(hwnd) };
  });
}
