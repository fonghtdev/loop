import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { hook, launchAs, register, type Session } from "./helpers";

// SAFE BY CONSTRUCTION: every run uses a throwaway LOOP_USER_DATA_DIR under the temp dir; the trash and the real uninstaller are
// never run under LOOP_E2E (the intended actions are written to a log file), and the profile helper runs only with LOOP_E2E_UNINSTALL_DELETE.
let user: Session;
test.beforeAll(async () => {
  user = await register("unin");
});

const logOf = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const fresh = () => ({ userData: mkdtempSync(join(tmpdir(), "loop-e2e-unin-")), log: join(mkdtempSync(join(tmpdir(), "loop-e2e-unin-log-")), "actions.jsonl") });

async function openDialog(page: Page) {
  await page.getByRole("button", { name: "Cài đặt của bạn" }).click();
  const button = page.getByRole("button", { name: "Gỡ cài đặt Loop…" });
  await button.scrollIntoViewIfNeeded();
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Gỡ cài đặt Loop?" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the dialog says what goes and what stays; the native confirmation declined leaves everything in place", async () => {
  const { userData, log } = fresh();
  const { app, page } = await launchAs(user, { userData, env: { LOOP_E2E_UNINSTALL_LOG: log } });
  try {
    const dialog = await openDialog(page);
    await expect(dialog).toContainText("Tài khoản và mọi dữ liệu trên máy chủ");
    await expect(dialog).toContainText("KHÔNG bị xoá");
    await expect(dialog).toContainText("Mục tự khởi động cùng máy");
    await dialog.getByRole("button", { name: "Huỷ" }).click();
    await expect(dialog).toBeHidden();
    expect(logOf(log)).toEqual([]); // cancelling the in-app dialog asks nothing of main

    const second = await openDialog(page);
    await second.getByRole("button", { name: "Tiếp tục gỡ cài đặt" }).click(); // the e2e answer is "no" by default
    await expect.poll(() => logOf(log).map((e) => e.action)).toEqual(["cancelled"]);
    expect(existsSync(userData)).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1); // still running
    await expect(page.getByLabel("Email")).toBeHidden(); // declining keeps the user signed in
    await expect(page.getByRole("heading", { name: "Cài đặt" }).first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("confirmed: the intended actions are recorded, the profile is gone after exit, another instance is untouched", async () => {
  const other = fresh();
  const { app: otherApp, page: otherPage } = await launchAs(user, { userData: other.userData });
  const { userData, log } = fresh();
  const { app, page } = await launchAs(user, { userData, env: { LOOP_E2E_UNINSTALL_LOG: log, LOOP_E2E_UNINSTALL_DELETE: "1" } });
  try {
    expect(existsSync(userData)).toBe(true);
    await hook(app, "setUninstallAnswer", true);
    const dialog = await openDialog(page);
    const closed = new Promise<void>((resolve) => app.process().once("exit", () => resolve()));
    await dialog.getByRole("button", { name: "Tiếp tục gỡ cài đặt" }).click();
    await closed;

    const entries = logOf(log);
    expect(entries.map((e) => e.action)).toEqual(["confirmed", "revokeRequest", "revoke", "loginItem", "trash", "deleteDir"]);
    expect(entries.find((e) => e.action === "revokeRequest")).toMatchObject({ status: 204 });
    expect(entries.find((e) => e.action === "trash")).toMatchObject({ path: expect.stringMatching(/\.app$/), executed: false });
    expect(entries.find((e) => e.action === "deleteDir")).toMatchObject({ path: userData, executed: true });
    await expect.poll(() => existsSync(userData), { timeout: 15_000 }).toBe(false);

    // the other profile and its running app are not affected
    expect(existsSync(other.userData)).toBe(true);
    await expect(otherPage.getByRole("heading", { name: "Bạn bè" })).toBeVisible();
  } finally {
    await app.close().catch(() => undefined);
    await otherApp.close();
  }
});
