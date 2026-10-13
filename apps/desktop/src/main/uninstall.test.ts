import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { posix, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertSafeToDelete, bundlePathFromExe, removableParent, removalHelper, runUninstall, uninstallRefusal, windowsUninstallerPath, type UninstallDeps } from "./uninstall";

const mac = { root: "/Users/ann/Library/Application Support", home: "/Users/ann", name: "@loop/desktop", lib: posix };
/** A fixed, deep temp root: the real os.tmpdir() is `/tmp` (too shallow for the safety check) on Linux CI but deep on macOS. These tests inject every side effect, so nothing here touches the disk. */
const FAKE_TMP = "/var/folders/ab/cd/T";
const winOpts = { root: "C:\\Users\\Ann\\AppData\\Roaming", home: "C:\\Users\\Ann", name: "Loop", lib: win32 };

describe("assertSafeToDelete", () => {
  it("accepts exactly the app's own data folder", () => {
    expect(assertSafeToDelete("/Users/ann/Library/Application Support/@loop/desktop", mac)).toBe("/Users/ann/Library/Application Support/@loop/desktop");
    expect(assertSafeToDelete("/Users/ann/Library/Application Support/@loop/desktop/", mac)).toBe("/Users/ann/Library/Application Support/@loop/desktop");
    expect(assertSafeToDelete("C:\\Users\\Ann\\AppData\\Roaming\\Loop", winOpts)).toBe("C:\\Users\\Ann\\AppData\\Roaming\\Loop");
    expect(assertSafeToDelete("c:\\users\\ann\\appdata\\roaming\\loop", winOpts)).toBe("c:\\users\\ann\\appdata\\roaming\\loop");
  });
  it.each([
    undefined, null, 42, "", "   ", "\0", "relative/Loop", "Loop", "~/Library/Application Support/@loop/desktop",
    "/", "//", "/Users", "/Users/ann", "/Users/ann/", "/Users/ann/Library", "/Users/ann/Library/Application Support",
    "/Users/ann/Library/Application Support/", "/Users/ann/Library/Application Support/@loop",
    "/Users/ann/Library/Application Support/other", "/Users/ann/Library/Application Support/@loop/desktop/sub",
    "/Users/ann/Library/Application Support/@loop/desktop/..", "/Users/ann/Library/Application Support/../@loop/desktop",
    "/Users/ann/Library/Application Support/x/../@loop/desktop", "/tmp/@loop/desktop", "/Applications/Loop.app",
    "/Users/ann/Library/Application Support/@loop/desktop\0/x",
  ])("refuses %j", (bad) => {
    expect(() => assertSafeToDelete(bad, mac)).toThrow(/unsafe path/);
  });
  it("refuses a shallow path and the home folder even when the name matches", () => {
    expect(() => assertSafeToDelete("/Users/Loop", { root: "/Users", home: "/Users/Loop", name: "Loop", lib: posix })).toThrow(/home|shallow/);
    expect(() => assertSafeToDelete("/a/Loop", { root: "/a", home: "/Users/ann", name: "Loop", lib: posix })).toThrow(/shallow/);
    expect(() => assertSafeToDelete("/Users/ann", { root: "/Users", home: "/Users/ann", name: "ann", lib: posix })).toThrow(/home/);
  });
  it.each(["C:\\", "C:", "C:\\Users", "C:\\Users\\Ann", "C:\\Users\\Ann\\AppData\\Roaming", "C:\\Users\\Ann\\AppData\\Roaming\\Other", "C:\\Users\\Ann\\AppData\\Roaming\\Loop\\..", "\\\\server\\share", "D:\\Loop"])("refuses Windows path %j", (bad) => {
    expect(() => assertSafeToDelete(bad, winOpts)).toThrow(/unsafe path/);
  });
});

describe("app paths", () => {
  it("derives the .app bundle from the executable", () => {
    expect(bundlePathFromExe("/Applications/Loop.app/Contents/MacOS/Loop")).toBe("/Applications/Loop.app");
    expect(bundlePathFromExe("/tmp/My Apps/Loop.app/Contents/MacOS/Loop")).toBe("/tmp/My Apps/Loop.app");
  });
  it.each(["/usr/local/bin/loop", "/Applications/Loop/Contents/MacOS/Loop", "/Applications/Loop.app/Contents/Loop", "/Applications/Loop.app/MacOS/Loop", "/Contents/MacOS/Loop", "/.app/Contents/MacOS/Loop", ""])("refuses exe %j", (exe) => {
    expect(bundlePathFromExe(exe)).toBeNull();
  });
  it("finds the NSIS uninstaller next to the exe", () => {
    expect(windowsUninstallerPath("C:\\Users\\Ann\\AppData\\Local\\Programs\\Loop\\Loop.exe")).toBe("C:\\Users\\Ann\\AppData\\Local\\Programs\\Loop\\Uninstall Loop.exe");
    expect(windowsUninstallerPath("/usr/bin/loop")).toBeNull();
  });
  it("refuses dev builds unless e2e with a throwaway profile, and unsupported platforms", () => {
    const base = { platform: "darwin", isPackaged: false, e2e: false, userDataOverridden: false };
    expect(uninstallRefusal(base)).toBe("refused");
    expect(uninstallRefusal({ ...base, e2e: true })).toBe("refused");
    expect(uninstallRefusal({ ...base, userDataOverridden: true })).toBe("refused");
    expect(uninstallRefusal({ ...base, e2e: true, userDataOverridden: true })).toBeNull();
    expect(uninstallRefusal({ ...base, isPackaged: true })).toBeNull();
    expect(uninstallRefusal({ ...base, isPackaged: true, platform: "linux" })).toBe("unsupported");
  });
});

describe("parent folder", () => {
  const appData = "/Users/ann/Library/Application Support";
  it("is the scope folder strictly inside appData", () => {
    expect(removableParent(`${appData}/@loop/desktop`, appData, posix)).toBe(`${appData}/@loop`);
  });
  it.each([`${appData}/Loop`, "/Users/ann/Library/Application Support/../x/desktop", "/elsewhere/@loop/desktop", `${appData}2/@loop/desktop`])("is none for %s", (dir) => {
    expect(removableParent(dir, appData, posix)).toBeNull();
  });
  it("passes the parent as one more argument, hostile characters and all", () => {
    const evil = `/p/@a "b" $(touch /tmp/x) \`id\``;
    const { args } = removalHelper("darwin", 1, "/p/@a/n", evil);
    expect(args.slice(2)).toEqual(["sh", "/p/@a/n", "1", evil]);
    expect(args[1]).toContain('rmdir -- "$3"');
    expect(args[1]).not.toMatch(/rm -r[^ ]* [^-]|-rf[^"]*"\$3"/);
    expect(removalHelper("darwin", 1, "/p/@a/n").args.slice(2)).toEqual(["sh", "/p/@a/n", "1"]);
    expect(removalHelper("win32", 1, "C:\\a", "C:\\b").env).toMatchObject({ LOOP_RM_PARENT: "C:\\b" });
    expect(removalHelper("win32", 1, "C:\\a").env).not.toHaveProperty("LOOP_RM_PARENT");
  });
  it.skipIf(process.platform === "win32")("really removes an empty scope folder but keeps one with a sibling", () => {
    for (const sibling of [false, true]) {
      const appDataDir = realpathSync(mkdtempSync(join(tmpdir(), "loop-parent-")));
      const scope = join(appDataDir, "@scope");
      mkdirSync(join(scope, "name"), { recursive: true });
      writeFileSync(join(scope, "name", "f"), "x");
      if (sibling) writeFileSync(join(scope, "other"), "keep");
      const dead = spawnSync("/bin/sh", ["-c", "exit 0"]).pid;
      const { cmd, args } = removalHelper("darwin", dead, join(scope, "name"), removableParent(join(scope, "name"), appDataDir));
      expect(spawnSync(cmd, args, { timeout: 10_000 }).status).toBe(0);
      expect(existsSync(join(scope, "name"))).toBe(false);
      expect(existsSync(scope)).toBe(sibling);
      expect(existsSync(appDataDir)).toBe(true);
    }
  });
});

describe("removalHelper", () => {
  it("passes the path and pid as arguments, never inside the script", () => {
    const evil = `/tmp/a "b" 'c' $(touch /tmp/pwn) \`id\` ; rm -rf /`;
    const { cmd, args, env } = removalHelper("darwin", 4242, evil);
    expect(cmd).toBe("/bin/sh");
    expect(args[0]).toBe("-c");
    expect(args[1]).toMatch(/^while kill -0 "\$2" 2>\/dev\/null; do sleep 0\.2; done; rm -rf -- "\$1"/);
    expect(args.slice(2)).toEqual(["sh", evil, "4242"]);
    expect(args[1]).not.toContain("tmp");
    expect(env).toBeUndefined();
  });
  it("on Windows passes them through the environment", () => {
    const evil = `C:\\x"; Remove-Item C:\\ -Recurse; "`;
    const { cmd, args, env } = removalHelper("win32", 7, evil);
    expect(cmd).toBe("powershell.exe");
    expect(args.join(" ")).not.toContain("Remove-Item C:");
    expect(args.join(" ")).not.toContain(evil);
    expect(env).toEqual({ LOOP_RM_PATH: evil, LOOP_RM_PID: "7" });
  });
  it.skipIf(process.platform === "win32")("really removes a hostile-named folder once the pid is gone and runs nothing from the name", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "loop-helper-")));
    const canary = join(base, "pwned");
    const evil = join(base, `a "b" 'c' $(touch ${canary}) \`touch ${canary}\` ; touch ${canary}`);
    mkdirSync(join(evil, "sub"), { recursive: true });
    writeFileSync(join(evil, "sub", "f"), "x");
    const dead = spawnSync("/bin/sh", ["-c", "exit 0"]).pid; // a pid that no longer exists
    const { cmd, args } = removalHelper("darwin", dead, evil);
    expect(spawnSync(cmd, args, { timeout: 10_000 }).status).toBe(0);
    expect(existsSync(evil)).toBe(false);
    expect(existsSync(canary)).toBe(false);
    expect(existsSync(base)).toBe(true);
  });
});

function deps(over: Partial<UninstallDeps> = {}) {
  const calls: string[] = [];
  const d: UninstallDeps = {
    platform: "darwin", isPackaged: true, e2e: false, userDataOverridden: false, deleteInE2e: false,
    userData: "/Users/ann/Library/Application Support/@loop/desktop", appData: "/Users/ann/Library/Application Support", tmpdir: "/tmp", home: "/Users/ann",
    exe: "/Applications/Loop.app/Contents/MacOS/Loop", appName: "@loop/desktop", pid: 99,
    exists: () => true,
    confirm: vi.fn(async () => (calls.push("confirm"), true)),
    revoke: async () => void calls.push("revoke"),
    revokeTimeoutMs: 50,
    removeLoginItem: () => void calls.push("loginItem"),
    teardown: async () => void calls.push("teardown"),
    trash: async (p) => void calls.push(`trash ${p}`),
    spawnDetached: (c) => void calls.push(`spawn ${c.cmd}`),
    warn: async (m) => void calls.push(`warn ${m.slice(0, 12)}`),
    exit: () => void calls.push("exit"),
    record: () => undefined,
    ...over,
  };
  return { d, calls };
}

describe("runUninstall", () => {
  it("does everything in order after the human click", async () => {
    const { d, calls } = deps();
    expect(await runUninstall(d)).toBe("done");
    expect(calls).toEqual(["confirm", "revoke", "loginItem", "teardown", "trash /Applications/Loop.app", "spawn /bin/sh", "exit"]);
  });
  it("revoke is not called when cancelled, nor on any refusal", async () => {
    const revoke = vi.fn(async () => undefined);
    for (const over of [{ confirm: async () => false }, { isPackaged: false }, { platform: "linux" }, { exe: "/usr/bin/loop" }]) {
      await runUninstall(deps({ ...over, revoke }).d);
    }
    expect(revoke).not.toHaveBeenCalled();
  });
  it("a revoke that throws or hangs does not block the uninstall", async () => {
    for (const revoke of [async () => { throw new Error("offline"); }, () => new Promise<void>(() => undefined)]) {
      const { d, calls } = deps({ revoke });
      expect(await runUninstall(d)).toBe("done");
      expect(calls).toEqual(["confirm", "loginItem", "teardown", "trash /Applications/Loop.app", "spawn /bin/sh", "exit"]);
    }
  });
  it("the helper also gets the scope folder as its parent argument (never in an e2e temp profile)", async () => {
    const spawned: string[][] = [];
    await runUninstall(deps({ spawnDetached: (c) => void spawned.push(c.args) }).d);
    expect(spawned[0].slice(2)).toEqual(["sh", "/Users/ann/Library/Application Support/@loop/desktop", "99", "/Users/ann/Library/Application Support/@loop"]);
    const temp = { e2e: true, isPackaged: false, userDataOverridden: true, deleteInE2e: true, userData: join(FAKE_TMP, "loop-e2e-x"), tmpdir: FAKE_TMP };
    await runUninstall(deps({ ...temp, spawnDetached: (c) => void spawned.push(c.args) }).d);
    expect(spawned[1].slice(2)).toEqual(["sh", temp.userData, "99"]);
  });
  it("cancel changes nothing", async () => {
    const { d, calls } = deps({ confirm: async () => false });
    expect(await runUninstall(d)).toBe("cancelled");
    expect(calls).toEqual([]);
  });
  it("an unpackaged build is refused before any dialog", async () => {
    const { d, calls } = deps({ isPackaged: false });
    expect(await runUninstall(d)).toBe("refused");
    expect(d.confirm).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  it("linux is refused with a message", async () => {
    const { d, calls } = deps({ platform: "linux" });
    expect(await runUninstall(d)).toBe("unsupported");
    expect(calls).toEqual(["warn Gỡ cài đặt t"]);
  });
  it("an unsafe data folder aborts before the dialog", async () => {
    for (const userData of ["/Users/ann", "/", "/Users/ann/Library"]) {
      const { d, calls } = deps({ userData });
      await expect(runUninstall(d)).rejects.toThrow(/unsafe path/);
      expect(d.confirm).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    }
  });
  it("an exe that is not inside a .app aborts before the dialog, with a message", async () => {
    const { d, calls } = deps({ exe: "/usr/bin/loop" });
    expect(await runUninstall(d)).toBe("refused");
    expect(d.confirm).not.toHaveBeenCalled();
    expect(calls).toEqual(["warn Không tìm th"]);
  });
  it("a failed trash still removes the data and tells the user", async () => {
    const { d, calls } = deps({ trash: async () => { throw new Error("denied"); } });
    expect(await runUninstall(d)).toBe("done");
    expect(calls).toEqual(["confirm", "revoke", "loginItem", "teardown", "warn Không chuyển", "spawn /bin/sh", "exit"]);
  });
  describe("under e2e", () => {
    const e2e = { e2e: true, isPackaged: false, userDataOverridden: true, userData: join(FAKE_TMP, "loop-e2e-x"), tmpdir: FAKE_TMP, home: "/Users/ann" };
    it("records but neither trashes, touches the login item nor spawns", async () => {
      const entries: Record<string, unknown>[] = [];
      const { d, calls } = deps({ ...e2e, record: (e) => void entries.push(e) });
      expect(await runUninstall(d)).toBe("done");
      expect(calls).toEqual(["confirm", "revoke", "teardown", "exit"]);
      expect(entries.map((e) => e.action)).toEqual(["confirmed", "revoke", "loginItem", "trash", "deleteDir"]);
      expect(entries.find((e) => e.action === "deleteDir")).toMatchObject({ path: e2e.userData, executed: false });
    });
    it("spawns the helper only with the dedicated flag, and only for a temp profile", async () => {
      const { d, calls } = deps({ ...e2e, deleteInE2e: true });
      await runUninstall(d);
      expect(calls).toEqual(["confirm", "revoke", "teardown", "spawn /bin/sh", "exit"]);
      const real = deps({ ...e2e, deleteInE2e: true, userData: "/Users/ann/Library/Application Support/@loop/desktop" });
      await expect(runUninstall(real.d)).rejects.toThrow(/unsafe path/);
      expect(real.calls).toEqual([]);
    });
  });
});

describe("wiring (source)", () => {
  const src = (f: string) => readFileSync(join(__dirname, f), "utf8");
  it("the IPC goes through handle() (sender check), not a bare ipcMain.handle, and takes no arguments", () => {
    const index = src("index.ts");
    expect(index).toMatch(/handle\("app:uninstall", \(\) => uninstallApp\(\(\) => revokeSession\(store\.get\(\)\)\)\)/);
    expect(index).not.toMatch(/ipcMain\.handle\("app:uninstall"/);
    expect(index).toMatch(/isTrustedSender\(event\.senderFrame/);
    expect(index).toMatch(/userData: app\.getPath\("userData"\)/);
  });
  it("the native dialog defaults to cancel", () => {
    expect(src("index.ts")).toMatch(/defaultId: 0,[^]*cancelId: 0/);
  });
  it("Windows user data goes with the NSIS uninstall", () => {
    expect(src("../../electron-builder.yml")).toMatch(/deleteAppDataOnUninstall: true/);
  });
  it("the settings screen only asks main (which revokes after the confirmation); the button is danger and opens a Dialog", () => {
    const ui = src("../renderer/src/components/UserSettings.tsx");
    expect(ui).toMatch(/await window\.loop\.uninstall\(\)/);
    expect(ui.slice(ui.indexOf("function UninstallSection"), ui.indexOf("function Group"))).not.toMatch(/logout/); // the server-side revoke happens in main, after the native confirmation
    expect(ui).toMatch(/variant="danger" onClick=\{\(\) => setOpen\(true\)\}/);
    expect(ui).toMatch(/<Dialog open=\{open\}/);
    expect(ui).toMatch(/title="userSettings\.uninstall"/);
    expect(src("../preload/index.ts")).toMatch(/uninstall: \(\) => ipcRenderer\.invoke\("app:uninstall"\)/);
  });
});
