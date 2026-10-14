import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCsp, ensureMediaAccess, isMediaKind, isPermissionAllowed, isSafeExternalUrl, isTrustedSender, isValidRefreshToken, resolveAppFile } from "./security";
import { isAllowedLivekitUrl } from "../shared/url";

describe("isSafeExternalUrl", () => {
  it.each(["https://loop.chat/help", "http://example.com"])("allows %s", (url) => {
    expect(isSafeExternalUrl(url)).toBe(true);
  });
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>1</script>",
    "app://loop/index.html",
    "smb://host/share",
    "not a url",
    "",
    `https://x.com/${"a".repeat(2100)}`,
    42,
    null,
  ])("rejects %s", (url) => {
    expect(isSafeExternalUrl(url)).toBe(false);
  });
});

describe("resolveAppFile", () => {
  const root = "/app/renderer";
  it("maps app://loop paths into the renderer dir", () => {
    expect(resolveAppFile(root, "app://loop/")).toBe(join(root, "index.html"));
    expect(resolveAppFile(root, "app://loop/assets/a.js?v=1")).toBe(join(root, "assets/a.js"));
  });
  it.each(["app://loop/../../etc/passwd", "app://loop/%2e%2e/%2e%2e/etc/passwd", "app://loop/..%2f..%2fetc", "app://loop/..%5c..%5cetc"])(
    "never leaves the renderer dir: %s",
    (url) => {
      const file = resolveAppFile(root, url);
      expect(file === null || file.startsWith(root + "/")).toBe(true);
    },
  );
  it.each(["app://other/index.html", "app://loop/%E0%A4%A", "file:///etc/passwd"])("refuses %s", (url) => {
    expect(resolveAppFile(root, url)).toBeNull();
  });
});

describe("buildCsp", () => {
  const origins = { api: "http://localhost:3000", ws: "ws://localhost:3000", storage: "http://localhost:9000", livekit: "ws://127.0.0.1:7880" };
  it("production: no inline code, network limited to the API, its websocket and the storage origin", () => {
    const csp = buildCsp(origins);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'"); // the wasm-only relaxation below is not this
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self' http://localhost:3000 ws://localhost:3000 http://localhost:9000 ws://127.0.0.1:7880 http://127.0.0.1:7880;");
  });
  it("LiveKit origin (ws and its http twin) is the configured one in production and dev; unrelated origins are absent", () => {
    for (const csp of [buildCsp(origins), buildCsp(origins, "http://localhost:5173")]) {
      expect(csp).toContain("ws://127.0.0.1:7880 http://127.0.0.1:7880");
      expect(csp).not.toContain("evil");
    }
    const cloud = buildCsp({ ...origins, livekit: "wss://x.livekit.cloud" });
    expect(cloud).toContain("wss://x.livekit.cloud https://x.livekit.cloud");
    expect(cloud).not.toContain("127.0.0.1");
  });
  it("images come from the storage origin (and blob: previews), in production and dev alike", () => {
    for (const csp of [buildCsp(origins), buildCsp(origins, "http://localhost:5173")])
      expect(csp).toContain("img-src 'self' data: blob: http://localhost:3000 http://localhost:9000;");
  });
  it("the storage origin is the configured one, not a constant", () => {
    const csp = buildCsp({ ...origins, storage: "https://files.example.com" });
    expect(csp).toContain("connect-src 'self' http://localhost:3000 ws://localhost:3000 https://files.example.com ws://127.0.0.1:7880 http://127.0.0.1:7880;");
    expect(csp).not.toContain("localhost:9000");
  });
  it("dev: allows the Vite dev server's inline preamble and HMR socket", () => {
    const csp = buildCsp(origins, "http://localhost:5173");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'");
    expect(csp).toContain("ws://localhost:5173");
    expect(csp).toContain("http://localhost:9000");
  });
});

describe("IPC payload checks", () => {
  it("accepts only base64url refresh tokens of sane length", () => {
    expect(isValidRefreshToken("abcDEF012-_")).toBe(true);
    for (const bad of ["", "a b", "x".repeat(513), 5, null, {}]) expect(isValidRefreshToken(bad)).toBe(false);
  });
  it("trusts only our own origins", () => {
    expect(isTrustedSender("app://loop/index.html")).toBe(true);
    expect(isTrustedSender("http://localhost:5173/", "http://localhost:5173")).toBe(true);
    expect(isTrustedSender("http://localhost:5173/")).toBe(false);
    expect(isTrustedSender("https://evil.example/")).toBe(false);
    expect(isTrustedSender("")).toBe(false);
  });
});

describe("isPermissionAllowed", () => {
  const dev = "http://localhost:5173";
  it("allows media and clipboard writes for our own pages only", () => {
    expect(isPermissionAllowed("media", "app://loop/index.html")).toBe(true);
    expect(isPermissionAllowed("media", "app://loop")).toBe(true);
    expect(isPermissionAllowed("media", "http://localhost:5173/", dev)).toBe(true);
    expect(isPermissionAllowed("clipboard-sanitized-write", "app://loop/index.html")).toBe(true);
    expect(isPermissionAllowed("display-capture", "app://loop/index.html")).toBe(true);
    expect(isPermissionAllowed("fullscreen", "app://loop/index.html")).toBe(true);
  });
  it.each(["notifications", "geolocation", "clipboard-read", "midi", "openExternal", "unknown"])("refuses %s even from the app origin", (p) => {
    expect(isPermissionAllowed(p, "app://loop/index.html", "http://localhost:5173")).toBe(false);
  });
  it.each(["https://evil.example/", "http://localhost:5173/", "app://other/", "file:///x.html", ""])("refuses media and screen capture for the foreign origin %s", (url) => {
    expect(isPermissionAllowed("media", url)).toBe(false);
    expect(isPermissionAllowed("display-capture", url)).toBe(false);
    expect(isPermissionAllowed("fullscreen", url)).toBe(false);
  });
});

describe("ensureMediaAccess", () => {
  const sp = (status: string, grant = true) => {
    const asked: string[] = [];
    return { asked, getMediaAccessStatus: () => status, askForMediaAccess: async (k: string) => (asked.push(k), grant) };
  };
  it("is true without asking anything off macOS", async () => {
    const s = sp("denied");
    expect(await ensureMediaAccess("microphone", "win32", s)).toBe(true);
    expect(s.asked).toEqual([]);
  });
  it("macOS: granted passes, not-determined asks once, denied/restricted fail without asking", async () => {
    expect(await ensureMediaAccess("camera", "darwin", sp("granted"))).toBe(true);
    const asking = sp("not-determined", true);
    expect(await ensureMediaAccess("camera", "darwin", asking)).toBe(true);
    expect(asking.asked).toEqual(["camera"]);
    expect(await ensureMediaAccess("camera", "darwin", sp("not-determined", false))).toBe(false);
    for (const status of ["denied", "restricted"]) {
      const s = sp(status);
      expect(await ensureMediaAccess("microphone", "darwin", s)).toBe(false);
      expect(s.asked).toEqual([]);
    }
  });
  it("screen: macOS granted/not-determined pass without asking, denied/restricted fail; elsewhere true", async () => {
    for (const status of ["granted", "not-determined"]) {
      const s = sp(status);
      expect(await ensureMediaAccess("screen", "darwin", s)).toBe(true);
      expect(s.asked).toEqual([]);
    }
    for (const status of ["denied", "restricted"]) expect(await ensureMediaAccess("screen", "darwin", sp(status))).toBe(false);
    expect(await ensureMediaAccess("screen", "win32", sp("denied"))).toBe(true);
  });
  it("only microphone, camera and screen are valid kinds", () => {
    expect(isMediaKind("microphone") && isMediaKind("camera") && isMediaKind("screen")).toBe(true);
    for (const bad of ["display", "", 1, null, undefined]) expect(isMediaKind(bad)).toBe(false);
  });
});

describe("isAllowedLivekitUrl", () => {
  it("accepts only the configured origin", () => {
    expect(isAllowedLivekitUrl("ws://127.0.0.1:7880", "ws://127.0.0.1:7880")).toBe(true);
    expect(isAllowedLivekitUrl("ws://127.0.0.1:7880/rtc?x=1", "ws://127.0.0.1:7880")).toBe(true);
    for (const bad of ["ws://localhost:7880", "wss://127.0.0.1:7880", "ws://127.0.0.1:7881", "ws://evil.example", "nope", "", null, 5])
      expect(isAllowedLivekitUrl(bad, "ws://127.0.0.1:7880")).toBe(false);
  });
});
