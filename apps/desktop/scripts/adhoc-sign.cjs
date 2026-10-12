// electron-builder `afterPack` hook. Builds are unsigned (mac.identity: null), which leaves the bundle with only Electron's own
// stray ad-hoc signature (Identifier=Electron, no _CodeSignature); Apple Silicon then refuses to run it ("Loop is damaged").
// An ad-hoc signature over the whole bundle (no certificate needed) makes it launchable once the user clears Gatekeeper.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

/** @param {{ electronPlatformName: string, appOutDir: string, packager: { appInfo: { productFilename: string } } }} context */
module.exports = async function adhocSign(context, run = execFileSync) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  run("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
