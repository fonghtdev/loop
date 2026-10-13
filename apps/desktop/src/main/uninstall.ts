import * as nodePath from "node:path";
import { basename, dirname, win32 } from "node:path";

type PathLib = typeof nodePath.posix;

/** What the uninstall asks of the OS, in one place so the destructive parts can be recorded instead of run (e2e). */
export type UninstallResult = "done" | "cancelled" | "refused" | "unsupported";

const MIN_SEGMENTS = 4;

/**
 * Throws unless `target` is exactly `<root>/<name>`, the app's own data folder: absolute, no `..`, not a filesystem or
 * drive root, not the home folder or any ancestor of it, deep enough, and nothing else. Pure string logic (no
 * symlink resolution): `rm -rf` of a symlink removes the link, never what it points to.
 */
export function assertSafeToDelete(target: unknown, { root, home, name, lib = nodePath as PathLib }: { root: string; home: string; name: string; lib?: PathLib }): string {
  const key = (s: string) => (lib === win32 ? s.toLowerCase() : s);
  if (typeof target !== "string" || target.trim() === "" || target.includes("\0")) throw new Error("unsafe path: empty");
  if (!lib.isAbsolute(target)) throw new Error("unsafe path: not absolute");
  if (target.split(/[\\/]+/).includes("..")) throw new Error("unsafe path: '..' segment");
  const dir = lib.resolve(target);
  const { root: fsRoot } = lib.parse(dir);
  if (dir === fsRoot) throw new Error("unsafe path: filesystem root");
  const h = lib.resolve(home);
  if (key(dir) === key(h) || key(h).startsWith(key(dir) + lib.sep)) throw new Error("unsafe path: home folder or an ancestor");
  if (dir.slice(fsRoot.length).split(lib.sep).filter(Boolean).length < MIN_SEGMENTS) throw new Error("unsafe path: too shallow");
  if (key(lib.relative(root, dir)) !== key(lib.normalize(name))) throw new Error("unsafe path: not the app's data folder");
  return dir;
}

/** `/Applications/Loop.app/Contents/MacOS/Loop` -> `/Applications/Loop.app`; null when the layout is not a .app bundle. */
export function bundlePathFromExe(exe: string): string | null {
  const macos = dirname(exe);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  return basename(macos) === "MacOS" && basename(contents) === "Contents" && basename(bundle).endsWith(".app") && basename(bundle) !== ".app" ? bundle : null;
}

/** The NSIS uninstaller electron-builder installs next to the exe; null when `exe` is not a .exe. */
export function windowsUninstallerPath(exe: string, productName = "Loop"): string | null {
  return win32.basename(exe).toLowerCase().endsWith(".exe") ? win32.join(win32.dirname(exe), `Uninstall ${productName}.exe`) : null;
}

/** Why an uninstall must not run here, or null. Dev builds only with the e2e hook AND a throwaway profile. */
export function uninstallRefusal({ platform, isPackaged, e2e, userDataOverridden }: { platform: string; isPackaged: boolean; e2e: boolean; userDataOverridden: boolean }): UninstallResult | null {
  if (platform !== "darwin" && platform !== "win32") return "unsupported";
  return isPackaged || (e2e && userDataOverridden) ? null : "refused";
}

// The folder to delete and the pid to wait for travel as arguments (POSIX) or environment variables (Windows), never inside the script text.
// The optional third argument is the emptied-out scope folder (`@loop`): removed with a NON-recursive rmdir, so it only goes if empty.
const POSIX_SCRIPT = 'while kill -0 "$2" 2>/dev/null; do sleep 0.2; done; rm -rf -- "$1"; [ -z "$3" ] || rmdir -- "$3" 2>/dev/null || true';
const WIN_SCRIPT =
  "$p = $env:LOOP_RM_PATH; Wait-Process -Id ([int]$env:LOOP_RM_PID) -ErrorAction SilentlyContinue; " +
  "for ($i = 0; $i -lt 20 -and (Test-Path -LiteralPath $p); $i++) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }; " +
  "$q = $env:LOOP_RM_PARENT; if ($q -and (Test-Path -LiteralPath $q) -and ((Get-ChildItem -LiteralPath $q -Force | Measure-Object).Count -eq 0)) { Remove-Item -LiteralPath $q }";

export type Command = { cmd: string; args: string[]; env?: Record<string, string> };

/**
 * The folder above the data folder (`<appData>/@loop` for `<appData>/@loop/desktop`) when it is strictly inside appData,
 * so it can be removed if the uninstall leaves it empty; null otherwise (e.g. the data folder sits directly in appData).
 */
export function removableParent(dataDir: string, appData: string, lib: PathLib = nodePath as PathLib): string | null {
  const parent = lib.dirname(dataDir);
  const rel = lib.relative(appData, parent);
  return rel !== "" && !rel.startsWith("..") && !lib.isAbsolute(rel) ? parent : null;
}

/** The detached helper that outlives us: waits until process `pid` is gone, then removes `target` (and `parent` if empty). */
export function removalHelper(platform: string, pid: number, target: string, parent: string | null = null): Command {
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WIN_SCRIPT],
      env: { LOOP_RM_PATH: target, LOOP_RM_PID: String(pid), ...(parent && { LOOP_RM_PARENT: parent }) },
    };
  }
  return { cmd: "/bin/sh", args: ["-c", POSIX_SCRIPT, "sh", target, String(pid), ...(parent ? [parent] : [])] };
}

export type UninstallDeps = {
  platform: string;
  isPackaged: boolean;
  e2e: boolean;
  /** LOOP_USER_DATA_DIR is set: the profile is a throwaway one. */
  userDataOverridden: boolean;
  /** e2e only: really delete the (temp) profile; everything else stays recorded-only. */
  deleteInE2e: boolean;
  userData: string;
  appData: string;
  tmpdir: string;
  home: string;
  exe: string;
  appName: string;
  pid: number;
  exists(path: string): boolean;
  confirm(): Promise<boolean>;
  /** Best-effort server-side sign-out (revokes the refresh token); only called after the human confirmed. */
  revoke(): Promise<void>;
  /** How long to wait for `revoke` before going on without it. */
  revokeTimeoutMs?: number;
  removeLoginItem(): void;
  /** Closes tray and windows and clears what Chromium keeps for the session. */
  teardown(): Promise<void>;
  trash(path: string): Promise<void>;
  spawnDetached(command: Command): void;
  /** A native message for the user (failures and refusals). */
  warn(message: string): Promise<void>;
  exit(): void;
  record(entry: Record<string, unknown>): void;
};

export const TRASH_FAILED = "Không chuyển được Loop vào Thùng rác. Dữ liệu của Loop trên máy này vẫn được xoá; hãy kéo Loop.app vào Thùng rác để gỡ nốt.";
export const UNSUPPORTED = "Gỡ cài đặt từ trong ứng dụng chỉ hỗ trợ macOS và Windows.";
export const NOT_FOUND = "Không tìm thấy trình gỡ cài đặt của Loop. Hãy gỡ Loop trong Cài đặt > Ứng dụng của Windows.";

/** The whole flow, every side effect injected. Nothing destructive happens before the human click. */
export async function runUninstall(d: UninstallDeps): Promise<UninstallResult> {
  const refusal = uninstallRefusal(d);
  if (refusal) {
    d.record({ action: "refused", reason: refusal });
    if (refusal === "unsupported") await d.warn(UNSUPPORTED);
    return refusal;
  }
  const throwaway = d.e2e && d.userDataOverridden;
  const dataDir = assertSafeToDelete(d.userData, throwaway ? { root: d.tmpdir, home: d.home, name: basename(d.userData) } : { root: d.appData, home: d.home, name: d.appName });
  const appPath = d.platform === "darwin" ? bundlePathFromExe(d.exe) : windowsUninstallerPath(d.exe);
  if (!appPath || (d.platform === "win32" && !d.exists(appPath))) {
    d.record({ action: "refused", reason: "no-app-path" });
    await d.warn(NOT_FOUND);
    return "refused";
  }

  if (!(await d.confirm())) {
    d.record({ action: "cancelled" });
    return "cancelled";
  }
  d.record({ action: "confirmed" });

  await Promise.race([d.revoke().catch(() => undefined), new Promise((r) => setTimeout(r, d.revokeTimeoutMs ?? 3000))]);
  d.record({ action: "revoke" });
  if (d.isPackaged) d.removeLoginItem(); // never touch the login items for a dev binary
  d.record({ action: "loginItem", openAtLogin: false });
  await d.teardown();

  if (d.platform === "darwin") {
    d.record({ action: "trash", path: appPath, executed: !d.e2e });
    if (!d.e2e) await d.trash(appPath).catch(() => d.warn(TRASH_FAILED));
  } else {
    d.record({ action: "uninstaller", path: appPath, executed: !d.e2e });
    if (!d.e2e) d.spawnDetached({ cmd: appPath, args: [] });
  }
  const run = !d.e2e || (throwaway && d.deleteInE2e);
  d.record({ action: "deleteDir", path: dataDir, executed: run });
  if (run) d.spawnDetached(removalHelper(d.platform, d.pid, dataDir, throwaway ? null : removableParent(dataDir, d.appData)));
  d.exit();
  return "done";
}
