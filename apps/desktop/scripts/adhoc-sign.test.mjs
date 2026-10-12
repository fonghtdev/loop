import { describe, expect, it, vi } from "vitest";
import adhocSign from "./adhoc-sign.cjs";

const ctx = (platform) => ({ electronPlatformName: platform, appOutDir: "/out/mac-arm64", packager: { appInfo: { productFilename: "Loop" } } });

describe("adhocSign", () => {
  it("ad-hoc signs the whole macOS bundle", async () => {
    const run = vi.fn();
    await adhocSign(ctx("darwin"), run);
    expect(run).toHaveBeenCalledWith("codesign", ["--force", "--deep", "--sign", "-", "/out/mac-arm64/Loop.app"], { stdio: "inherit" });
  });
  it("does nothing for other platforms", async () => {
    const run = vi.fn();
    await adhocSign(ctx("win32"), run);
    expect(run).not.toHaveBeenCalled();
  });
});
