import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { appArgs, PACKAGED } from "./helpers";

// Screenshots go to E2E_SCREENSHOT_DIR (default: test-results/screens).
const shots = process.env.E2E_SCREENSHOT_DIR ?? join(__dirname, "../test-results/screens");
const userData = mkdtempSync(join(tmpdir(), "loop-e2e-"));
const name = `e2e_${Date.now().toString(36)}`;
const email = `${name}@example.com`;
const password = "correct-horse-battery";

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({ executablePath: PACKAGED, args: appArgs(), env: { ...process.env, LOOP_USER_DATA_DIR: userData } });
  return { app, page: await app.firstWindow() };
}
const shot = async (page: Page, file: string) => {
  await page.waitForTimeout(500); // let entrance animations finish
  await page.screenshot({ path: join(shots, `${file}.png`) });
};
const resize = (app: ElectronApplication, width: number, height: number) =>
  app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height]);

test("register, restore the session after a relaunch, logout, wrong password", async () => {
  let { app, page } = await launch();

  // renderer is locked down: no Node, CSP blocks inline scripts (eval cannot be probed: Playwright's evaluate bypasses CSP), small bridge only
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe("undefined");
  expect(await page.evaluate(() => Object.keys(window.loop).sort())).toEqual([
    "closeNotification",
    "media",
    "notify",
    "onFocusChange",
    "onNavigate",
    "openExternal",
    "platform",
    "session",
    "setBadge",
    "settings",
    "update",
    "version",
  ]);
  const inlineRan = await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__inline = true";
    document.head.append(s);
    return (window as { __inline?: boolean }).__inline === true;
  });
  expect(inlineRan).toBe(false);

  await expect(page.getByRole("heading", { name: "Chào mừng trở lại" })).toBeVisible();
  await shot(page, "02-login");
  // the auth card is the glass panel of the screen
  const card = page.getByRole("heading", { name: "Chào mừng trở lại" }).locator("xpath=ancestor::div[contains(@class,'glass')]");
  const glass = await card.evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(glass).toMatch(/^blur\(\d+px\)/);
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await expect(page.getByText("Vui lòng điền mục này.").first()).toBeVisible();
  await shot(page, "03-login-validation");

  await page.getByRole("button", { name: "Tạo tài khoản" }).click();
  await expect(page.getByRole("heading", { name: "Tạo tài khoản" })).toBeVisible();
  await shot(page, "04-register");
  await page.getByLabel("Email").fill("không-phải-email");
  await page.getByLabel("Tên người dùng").fill("Nguyễn Văn Ạ ặ ữ");
  await page.getByLabel("Mật khẩu", { exact: true }).fill("ngắn");
  await page.getByRole("button", { name: "Tạo tài khoản" }).first().click();
  await expect(page.getByText("Mật khẩu cần ít nhất 8 ký tự.")).toBeVisible();
  await page.getByRole("button", { name: "Hiện mật khẩu" }).click();
  await shot(page, "05-register-validation-diacritics");

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Tên người dùng").fill(name);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Bạn bè" })).toBeVisible();
  await expect(page.getByText("không hỗ trợ lưu đăng nhập an toàn")).toHaveCount(0); // macOS: keychain available
  await shot(page, "06-shell-1280x800");
  await resize(app, 960, 600);
  await page.waitForTimeout(300);
  await shot(page, "07-shell-min-960x600");
  await resize(app, 1920, 1200);
  await page.waitForTimeout(300);
  await shot(page, "08-shell-large-1920w");
  await app.close();

  ({ app, page } = await launch());
  await page.screenshot({ path: join(shots, "09a-relaunch-first-paint-splash.png") }); // no wait: catch the splash if we can
  await expect(page.getByRole("heading", { name: "Bạn bè" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chào mừng trở lại" })).toHaveCount(0);
  await shot(page, "09-shell-restored-after-relaunch");

  // offline notice: emulate a dropped network through DevTools (navigator.onLine + the offline event)
  const cdp = await page.context().newCDPSession(page);
  const network = (offline: boolean) =>
    cdp.send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.send("Network.enable");
  await network(true);
  await expect(page.getByText("Mất kết nối mạng.")).toBeVisible();
  await shot(page, "09b-shell-offline-banner");
  await network(false);
  await expect(page.getByText("Mất kết nối mạng.")).toHaveCount(0);

  await page.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(page.getByRole("heading", { name: "Chào mừng trở lại" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mật khẩu", { exact: true }).fill("wrong-password");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Email hoặc mật khẩu không đúng.")).toBeVisible();
  await shot(page, "10-login-wrong-password");
  await resize(app, 960, 600);
  await page.getByRole("button", { name: "Tạo tài khoản" }).click();
  await page.getByRole("button", { name: "Tạo tài khoản" }).first().click();
  await page.waitForTimeout(300);
  await shot(page, "11-register-validation-min-960x600");
  await app.close();

  // logout removed the stored session: a relaunch lands on the login screen
  ({ app, page } = await launch());
  await expect(page.getByRole("heading", { name: "Chào mừng trở lại" })).toBeVisible();
  await app.close();
});
