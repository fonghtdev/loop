import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCsp, isSafeExternalUrl, isTrustedSender, isValidRefreshToken, resolveAppFile } from "./security";

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
  const origins = { api: "http://localhost:3000", ws: "ws://localhost:3000", storage: "http://localhost:9000" };
  it("production: no inline code, network limited to the API, its websocket and the storage origin", () => {
    const csp = buildCsp(origins);
    expect(csp).not.toContain("unsafe");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("connect-src 'self' http://localhost:3000 ws://localhost:3000 http://localhost:9000;");
  });
  it("images come from the storage origin (and blob: previews), in production and dev alike", () => {
    for (const csp of [buildCsp(origins), buildCsp(origins, "http://localhost:5173")])
      expect(csp).toContain("img-src 'self' data: blob: http://localhost:3000 http://localhost:9000;");
  });
  it("the storage origin is the configured one, not a constant", () => {
    const csp = buildCsp({ ...origins, storage: "https://files.example.com" });
    expect(csp).toContain("connect-src 'self' http://localhost:3000 ws://localhost:3000 https://files.example.com;");
    expect(csp).not.toContain("localhost:9000");
  });
  it("dev: allows the Vite dev server's inline preamble and HMR socket", () => {
    const csp = buildCsp(origins, "http://localhost:5173");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
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
