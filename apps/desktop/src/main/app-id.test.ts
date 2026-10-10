import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { APP_ID } from "../shared/app-id";

it("the installer's appId (electron-builder.yml) is the AppUserModelId the app sets", () => {
  const yml = readFileSync(join(__dirname, "../../electron-builder.yml"), "utf8");
  expect(/^appId:\s*(\S+)\s*$/m.exec(yml)?.[1]).toBe(APP_ID);
  expect(readFileSync(join(__dirname, "index.ts"), "utf8")).toContain("app.setAppUserModelId(APP_ID)");
});
