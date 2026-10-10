import { expect, test } from "@playwright/test";
import { hook, launchAs, register } from "./helpers";

// 10: only against a packaged app (LOOP_EXECUTABLE_PATH=...); `pnpm e2e` without it skips this file.
test.skip(!process.env.LOOP_EXECUTABLE_PATH, "needs LOOP_EXECUTABLE_PATH");

test("the packaged app serves the renderer from app://loop inside the asar, has a tray, and shows updates as off", async () => {
  const { app, page } = await launchAs(await register("pkg"));
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  expect(await app.evaluate(({ app }) => app.getAppPath())).toMatch(/app\.asar$/);
  expect(page.url()).toMatch(/^app:\/\/loop\//);
  expect(await app.evaluate(({ app }) => app.getVersion())).toBe("0.1.0");
  expect(await hook(app, "tray")).toEqual({ exists: true });

  await page.getByRole("button", { name: "Cài đặt của bạn" }).click();
  await expect(page.getByRole("heading", { name: "Cập nhật" })).toBeVisible();
  await expect(page.getByText("Cập nhật tự động chưa được bật cho bản này")).toBeVisible();
  await expect(page.getByRole("button", { name: "Kiểm tra cập nhật" })).toHaveCount(0);
  await app.close();
});
