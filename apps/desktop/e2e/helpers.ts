import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { _electron, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { io, type Socket } from "socket.io-client";

// Shared by the 9c specs: "other users" are plain API / socket.io-client scripts, so one Electron window is enough.
export const API = "http://localhost:3000";
export const run = Date.now().toString(36);
export const password = "correct-horse-battery";

export type Session = { token: string; user: { id: string; username: string } };

export async function api<T = unknown>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** The status of a call that is expected to fail (no throw). */
export async function status(token: string, method: string, path: string, body?: unknown): Promise<number> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  return (await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })).status;
}

export async function register(tag: string): Promise<Session> {
  const username = `${tag}_${run}`.toLowerCase().slice(0, 32);
  const r = await api<{ accessToken: string; user: Session["user"] }>(null, "POST", "/auth/register", { email: `${username}@example.com`, username, password });
  return { token: r.accessToken, user: r.user };
}

export async function befriend(a: Session, b: Session) {
  await api(a.token, "POST", "/friends/requests", { username: b.user.username });
  await api(b.token, "POST", `/friends/requests/${a.user.id}/accept`);
}

export type Event = { event: string; data: any };

/** A socket.io user (a script) that records every event it gets. */
export async function connect(s: Session) {
  const events: Event[] = [];
  const socket: Socket = io(API, { auth: { token: s.token }, transports: ["websocket"], reconnection: false });
  socket.onAny((event, data) => events.push({ event, data }));
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", reject);
  });
  const waitFor = (event: string, pred: (d: any) => boolean = () => true) =>
    expect.poll(() => events.some((e) => e.event === event && pred(e.data)), { timeout: 10_000, message: `event ${event}` }).toBe(true);
  return { socket, events, waitFor, close: () => void socket.close() };
}
export type Conn = Awaited<ReturnType<typeof connect>>;

/** A real, valid PNG of one colour (so the browser can decode and show it). */
export function makePng(width = 64, height = 48, rgb = [90, 140, 200]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

/** Uploads through the real three-step flow as `s`; returns the READY attachment id. */
export async function uploadAs(
  s: Session,
  target: { channelId: string } | { dmChannelId: string },
  filename: string,
  contentType: string,
  bytes: Buffer,
): Promise<string> {
  const r = await api<{ id: string; uploadUrl: string; headers: Record<string, string> }>(s.token, "POST", "/attachments", {
    filename,
    contentType,
    size: bytes.length,
    ...target,
  });
  const put = await fetch(r.uploadUrl, { method: "PUT", headers: r.headers, body: new Uint8Array(bytes) });
  if (!put.ok) throw new Error(`PUT ${put.status}`);
  await api(s.token, "POST", `/attachments/${r.id}/complete`);
  return r.id;
}

// ---- the Electron window ----
/** Launches the built app (or the Vite dev server when ELECTRON_RENDERER_URL is set) and signs `s` in. */
export const MAIN = join(__dirname, "../out/main/index.js");
/** LOOP_E2E=1 turns on the main process's test hook (notifications are recorded instead of shown). */
export const launchEnv = (userData: string) => ({ ...process.env, LOOP_USER_DATA_DIR: userData, LOOP_E2E: "1" });
/** Calls a function of the main process's test hook (only exists when LOOP_E2E=1). */
export const hook = <T = unknown>(app: ElectronApplication, name: string, ...args: unknown[]): Promise<T> =>
  app.evaluate((_, [n, a]) => (globalThis as unknown as { __loopE2E: Record<string, (...x: unknown[]) => unknown> }).__loopE2E[n as string](...(a as unknown[])), [name, args]) as Promise<T>;

export async function launchAs(s: Session, { userData = mkdtempSync(join(tmpdir(), "loop-e2e-9c-")), args = [] as string[] } = {}): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const app = await _electron.launch({ args: [...args, MAIN], env: launchEnv(userData) });
  const page = await app.firstWindow();
  await page.getByLabel("Email").fill(`${s.user.username}@example.com`);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Bạn bè" })).toBeVisible();
  return { app, page, userData };
}

export const resize = (app: ElectronApplication, w: number, h: number) =>
  app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);

/** No horizontal overflow in the given elements. */
export async function expectNoHorizontalOverflow(locators: Locator[]) {
  for (const l of locators) {
    const { scrollWidth, clientWidth, html } = await l.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, html: el.outerHTML.slice(0, 80) }));
    expect(scrollWidth, html).toBeLessThanOrEqual(clientWidth);
  }
}

export async function expectEllipsis(l: Locator) {
  const r = await l.evaluate((el) => ({ overflow: getComputedStyle(el).textOverflow, cut: el.scrollWidth > el.clientWidth }));
  expect(r).toEqual({ overflow: "ellipsis", cut: true });
}

/** Offline / online for the window's network (the socket drops with it). */
export async function networkSwitch(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  return (offline: boolean) => cdp.send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}
