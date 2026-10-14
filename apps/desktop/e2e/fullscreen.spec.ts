import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect, test } from "@playwright/test";
import { appArgs, PACKAGED } from "./helpers";

// The stream tile's fullscreen button calls element.requestFullscreen(): the permission handler must let it through.
test("an element of our own page can go fullscreen", async () => {
  const app = await _electron.launch({ executablePath: PACKAGED, args: appArgs(), env: { ...process.env, LOOP_USER_DATA_DIR: mkdtempSync(join(tmpdir(), "loop-e2e-")) } });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const result = await page.evaluate(async () => {
      const box = document.createElement("div");
      document.body.append(box);
      try {
        await box.requestFullscreen();
        return document.fullscreenElement === box ? "fullscreen" : "not fullscreen";
      } catch (e) {
        return `rejected: ${(e as Error).message}`;
      }
    });
    expect(result).toBe("fullscreen");
  } finally {
    await app.close();
  }
});
