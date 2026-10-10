import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { api, befriend, expectNoHorizontalOverflow, hook, launchAs, launchEnv, MAIN, makePng, register, resize, run, uploadAs, type Session } from "./helpers";
import { callToken, joinRoom, leaveAll } from "./livekit";

// 9f: unread tracking, OS notifications (recorded by the LOOP_E2E hook, never shown), badges, tray, close-to-tray,
// single instance and settings against the REAL dev server + docker. Everyone but A is a script.
const FAKE_MEDIA = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
let app: ElectronApplication;
let page: Page;
let userData: string;
let A: Session;
let B: Session;
let dmId: string;
let guildId: string;
let randomId: string;
let generalId: string;

type Notice = { key: string; title: string; body: string; kind: string; closed: boolean };
const notices = () => hook<Notice[]>(app, "notifications");
const setFocused = (v: boolean | null) => hook(app, "setFocused", v);
const rail = () => page.getByRole("navigation", { name: "Danh sách máy chủ" });
const dmList = () => page.getByRole("list", { name: "Danh sách tin nhắn trực tiếp" });
const dmButton = (s: Session) => dmList().getByRole("button", { name: new RegExp(s.user.username) });
const channelButton = (name: string) => page.getByRole("list", { name: "Danh sách kênh" }).getByRole("button", { name: new RegExp(`^${name}`) });
const bPost = (content: string, attachmentIds?: string[]) => api(B.token, "POST", `/dms/${dmId}/messages`, { content, ...(attachmentIds && { attachmentIds }) });
const goFriends = () => dmList().getByRole("button", { name: "Bạn bè" }).click();
const goHome = () => rail().getByRole("button", { name: "Trang chủ" }).click();
const openDm = async () => {
  await goHome();
  await dmButton(B).click();
  await expect(page.getByRole("log")).toBeVisible();
};
const openSettings = () => page.getByRole("button", { name: "Cài đặt của bạn" }).click();
const sw = (name: string) => page.getByRole("switch", { name });
const clean = async () => {
  await expect(page).toHaveTitle("Loop");
  await expect.poll(() => hook(app, "badge")).toBe(0);
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  [A, B] = await Promise.all([register("na"), register("nb")]);
  await befriend(A, B);
  dmId = (await api<{ id: string }>(A.token, "POST", "/dms", { userId: B.user.id })).id;
  const { guild, channels } = await api<{ guild: { id: string }; channels: { id: string; name: string }[] }>(A.token, "POST", "/guilds", { name: `Noti ${run}` });
  guildId = guild.id;
  generalId = channels[0].id;
  randomId = (await api<{ id: string }>(A.token, "POST", `/guilds/${guildId}/channels`, { name: "random", type: "TEXT" })).id;
  const { code } = await api<{ code: string }>(A.token, "POST", `/guilds/${guildId}/invites`, {});
  await api(B.token, "POST", `/invites/${code}/join`);
  ({ app, page, userData } = await launchAs(A, { args: FAKE_MEDIA }));
  await setFocused(true);
});
test.afterAll(async () => {
  await leaveAll();
  await app?.close().catch(() => undefined);
});

test("a DM from B while A is elsewhere: Home badge, bold DM row with a count, title prefix, dock badge, one notification", async () => {
  await bPost("hello one");
  await expect(rail().getByText("1 tin nhắn chưa đọc")).toBeVisible();
  await expect(dmButton(B)).toHaveAttribute("data-unread", "true");
  await expect(dmButton(B).getByText("1 tin nhắn chưa đọc")).toBeVisible();
  expect(await dmButton(B).evaluate((el) => getComputedStyle(el).fontWeight)).toBe("700");
  await expect(page).toHaveTitle("(1) Loop");
  await expect.poll(() => hook(app, "badge")).toBe(1);
  await expect.poll(async () => (await notices()).length).toBe(1);
  expect((await notices())[0]).toMatchObject({ key: `dm:${dmId}`, title: B.user.username, body: "hello one", kind: "message", closed: false });
  await bPost("hello two");
  await expect(rail().getByText("2 tin nhắn chưa đọc")).toBeVisible();
  await expect.poll(() => hook(app, "badge")).toBe(2);
  const log = await notices();
  expect(log.filter((n) => n.key === `dm:${dmId}` && !n.closed)).toHaveLength(1); // one notification per conversation, replaced
});

test("opening the DM clears the badge, the bold row, the title and the dock count", async () => {
  await dmButton(B).click();
  await expect(page.getByRole("log").getByText("hello two")).toBeVisible();
  await expect(rail().getByText(/tin nhắn chưa đọc/)).toHaveCount(0);
  await expect(dmButton(B)).not.toHaveAttribute("data-unread", "true");
  await clean();
});

test("our own message (from another device) never counts and never notifies", async () => {
  await goFriends();
  const before = (await notices()).length;
  await api(A.token, "POST", `/dms/${dmId}/messages`, { content: "from my phone" });
  await page.waitForTimeout(800);
  await expect(rail().getByText(/tin nhắn chưa đọc/)).toHaveCount(0);
  expect((await notices()).length).toBe(before);
  await clean();
});

test("window not focused: the open DM notifies and counts; focus returns -> read. Focused on that DM: no notification, no count", async () => {
  await openDm();
  await setFocused(false);
  const before = (await notices()).length;
  await bPost("while away");
  await expect.poll(async () => (await notices()).length).toBe(before + 1);
  await expect(rail().getByText("1 tin nhắn chưa đọc")).toBeVisible();
  await expect(page).toHaveTitle("(1) Loop");
  await setFocused(true);
  await expect(rail().getByText(/tin nhắn chưa đọc/)).toHaveCount(0);
  await clean();

  await bPost("right here");
  await expect(page.getByRole("log").getByText("right here")).toBeVisible();
  await page.waitForTimeout(800);
  expect((await notices()).length).toBe(before + 1); // looking at it: nothing
  await clean();
});

test("scrolled up in the DM: new messages count even while focused; scrolling to the bottom reads them", async () => {
  for (let i = 0; i < 40; i++) await api(B.token, "POST", `/dms/${dmId}/messages`, { content: `filler ${i}` });
  await expect(page.getByRole("log").getByText("filler 39")).toBeVisible();
  await clean();
  await page.getByRole("log").evaluate((el) => (el.parentElement!.scrollTop = 0));
  await page.waitForTimeout(300);
  await bPost("while scrolled up");
  await expect(rail().getByText("1 tin nhắn chưa đọc")).toBeVisible();
  await page.getByRole("button", { name: /tin nhắn mới/ }).click();
  await expect(rail().getByText(/tin nhắn chưa đọc/)).toHaveCount(0);
  await clean();
});

test("settings: preview off redacts the text, notifications off silences; switches are labelled and saved", async () => {
  await goFriends();
  await openSettings();
  await expect(page.getByRole("heading", { name: "Cài đặt của bạn" })).toBeFocused();
  await expect(sw("Hiện nội dung tin nhắn")).toHaveAttribute("aria-checked", "true");
  await sw("Hiện nội dung tin nhắn").click();
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu." })).toBeVisible();
  await expect(sw("Hiện nội dung tin nhắn")).toHaveAttribute("aria-checked", "false");
  expect(await hook<{ preview: boolean }>(app, "settings")).toMatchObject({ preview: false });
  await setFocused(false);

  await bPost("secret text 123");
  await expect.poll(async () => (await notices()).some((n) => n.title === B.user.username && n.body === "Tin nhắn mới")).toBe(true);
  expect(JSON.stringify(await notices())).not.toContain("secret text 123");

  // attachment only
  const png = await uploadAs(B, { dmChannelId: dmId }, "anh.png", "image/png", makePng());
  await bPost("", [png]);
  await expect.poll(async () => (await notices()).filter((n) => n.body === "Tin nhắn mới").length).toBe(2);
  await sw("Hiện nội dung tin nhắn").click();
  await expect(sw("Hiện nội dung tin nhắn")).toHaveAttribute("aria-checked", "true");
  const withFile = await notices().then((l) => l.length);
  const file = await uploadAs(B, { dmChannelId: dmId }, "anh2.png", "image/png", makePng());
  await bPost("", [file]);
  await expect.poll(async () => (await notices()).length).toBe(withFile + 1);
  expect((await notices()).at(-1)!.body).toBe("đã gửi một tệp");

  // notifications off: nothing more, the preview switch is disabled
  await sw("Thông báo trên máy tính").click();
  await expect(sw("Hiện nội dung tin nhắn")).toBeDisabled();
  const off = (await notices()).length;
  await bPost("quiet");
  await expect(rail().getByText(/tin nhắn chưa đọc/)).toBeVisible(); // still counted
  await page.waitForTimeout(800);
  expect((await notices()).length).toBe(off);
  await sw("Thông báo trên máy tính").click();
  await expect(sw("Hiện nội dung tin nhắn")).toBeEnabled();
  await setFocused(true);
  await page.getByRole("button", { name: "Đóng cài đặt" }).click();
  await openDm();
  await clean();
});

test("a channel of the open server: bold row with a dot, title prefix, no notification; own message and the open channel never count", async () => {
  await rail().getByRole("button", { name: `Noti ${run}` }).click();
  await channelButton("general").click();
  const before = (await notices()).length;
  await api(B.token, "POST", `/channels/${randomId}/messages`, { content: "hi random" });
  await expect(channelButton("random")).toHaveAttribute("data-unread", "true");
  await expect(channelButton("random").getByText("Có tin nhắn chưa đọc")).toBeVisible();
  await expect(page).toHaveTitle("(1) Loop");
  await expect.poll(() => hook(app, "badge")).toBe(1);
  await api(B.token, "POST", `/channels/${generalId}/messages`, { content: "in the open one" });
  await expect(page.getByRole("log").getByText("in the open one")).toBeVisible();
  await expect(page).toHaveTitle("(1) Loop"); // still just the one in #random
  expect((await notices()).length).toBe(before); // channels never notify
  // our own message is never counted, and replying there means we are caught up
  await api(A.token, "POST", `/channels/${randomId}/messages`, { content: "mine" });
  await expect(page).toHaveTitle("Loop");
  // a message deleted while unread leaves no phantom count
  const m = await api<{ id: string }>(B.token, "POST", `/channels/${randomId}/messages`, { content: "oops" });
  await expect(page).toHaveTitle("(1) Loop");
  await api<{ id: string }>(B.token, "POST", `/channels/${randomId}/messages`, { content: "oops 2" });
  await expect(page).toHaveTitle("(2) Loop");
  await api(B.token, "DELETE", `/messages/${m.id}`);
  await expect(page).toHaveTitle("(1) Loop");

  await channelButton("random").click();
  await expect(channelButton("random")).not.toHaveAttribute("data-unread", "true");
  await clean();
});

test("an incoming call notifies with the caller's name and closes when declined / answered", async () => {
  await goHome();
  await goFriends();
  const first = await joinRoom(await callToken(B, dmId, false), { mic: false });
  await expect(page.getByRole("button", { name: "Trả lời" })).toBeVisible();
  await expect.poll(async () => (await notices()).filter((n) => n.key === `call:${dmId}`).length).toBe(1);
  let call = (await notices()).filter((n) => n.key === `call:${dmId}`).at(-1)!;
  expect(call).toMatchObject({ title: B.user.username, body: "Cuộc gọi đến", kind: "call", closed: false });
  await page.getByRole("button", { name: "Từ chối" }).click();
  await expect.poll(async () => (await notices()).filter((n) => n.key === `call:${dmId}`).at(-1)!.closed).toBe(true);
  await first.leave();

  await page.waitForTimeout(2500);
  const second = await joinRoom(await callToken(B, dmId, true), { mic: false });
  await expect.poll(async () => (await notices()).filter((n) => n.key === `call:${dmId}`).length).toBe(2);
  call = (await notices()).filter((n) => n.key === `call:${dmId}`).at(-1)!;
  expect(call).toMatchObject({ body: "Cuộc gọi video đến", kind: "video-call", closed: false });
  await page.getByRole("button", { name: "Trả lời" }).click();
  await expect.poll(async () => (await notices()).filter((n) => n.key === `call:${dmId}`).at(-1)!.closed).toBe(true);
  await page.getByRole("button", { name: /^(Kết thúc cuộc gọi|Huỷ cuộc gọi)$/ }).click();
  await second.leave();
});

test("clicking a notification opens that DM", async () => {
  await goFriends();
  await setFocused(false);
  await bPost("click me");
  await expect.poll(async () => (await notices()).some((n) => n.body === "click me")).toBe(true);
  await hook(app, "clickNotification", `dm:${dmId}`);
  await expect(page.getByRole("heading", { name: B.user.username })).toBeVisible();
  await expect(page.getByRole("log").getByText("click me")).toBeVisible();
  await setFocused(true);
  await clean();
});

test("invalid IPC payloads are rejected by the main process", async () => {
  const results = await page.evaluate(async () => {
    const out: Record<string, string> = {};
    const attempt = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        out[name] = "accepted";
      } catch {
        out[name] = "rejected";
      }
    };
    const api = window.loop as unknown as Record<string, any>;
    const key = "dm:0a1b2c3d-0000-4000-8000-000000000001";
    await attempt("settings string", () => api.settings.set({ preview: "no" }));
    await attempt("settings unknown", () => api.settings.set({ admin: true }));
    await attempt("settings empty", () => api.settings.set({}));
    await attempt("settings null", () => api.settings.set(null));
    await attempt("notify bad key", () => api.notify({ conversationKey: "dm:../x", title: "t", body: "b", kind: "message" }));
    await attempt("notify call key for message", () => api.notify({ conversationKey: key.replace("dm", "call"), title: "t", body: "b", kind: "message" }));
    await attempt("notify long title", () => api.notify({ conversationKey: key, title: "t".repeat(81), body: "b", kind: "message" }));
    await attempt("notify long body", () => api.notify({ conversationKey: key, title: "t", body: "b".repeat(201), kind: "message" }));
    await attempt("notify extra kind", () => api.notify({ conversationKey: key, title: "t", body: "b", kind: "alert" }));
    await attempt("close bad key", () => api.closeNotification("x"));
    await attempt("badge negative", () => api.setBadge(-1));
    await attempt("badge fraction", () => api.setBadge(1.5));
    await attempt("badge huge", () => api.setBadge(1e9));
    await attempt("badge string", () => api.setBadge("3"));
    return out;
  });
  expect(Object.values(results).every((r) => r === "rejected"), JSON.stringify(results)).toBe(true);
  expect(await hook(app, "settings")).toMatchObject({ notifications: true, preview: true });
});

test("settings view: no horizontal overflow at 1280x800 and 960x600, with many unread DMs too", async () => {
  const friends = await Promise.all(Array.from({ length: 14 }, (_, i) => register(`nf${i}`)));
  await setFocused(false);
  await goFriends();
  for (const f of friends) {
    await befriend(A, f);
    const dm = await api<{ id: string }>(f.token, "POST", "/dms", { userId: A.user.id });
    for (let i = 0; i < (f === friends[0] ? 12 : 2); i++) await api(f.token, "POST", `/dms/${dm.id}/messages`, { content: `n${i} ${"x".repeat(60)}` });
  }
  await expect(rail().getByText("9+", { exact: false })).toBeVisible();
  await expect.poll(() => hook(app, "badge")).toBeGreaterThan(14);
  for (const [w, h] of [[1280, 800], [960, 600]]) {
    await resize(app, w, h);
    await expectNoHorizontalOverflow([rail(), page.getByRole("navigation", { name: "Kênh" }), page.locator("main")]);
    await openSettings();
    await expectNoHorizontalOverflow([page.locator("main"), page.locator("main section").first()]);
    await page.getByRole("button", { name: "Đóng cài đặt" }).click();
  }
  await resize(app, 1280, 800);
  await setFocused(true);
});

test("restart: a DM that got a message while the app was closed shows unread again; settings survive", async () => {
  await openDm();
  await expect.poll(() => page.getByRole("log").getByText("click me").count()).toBe(1);
  await goFriends();
  // everything the friends sent above is read by opening each? only B matters: clear the rest by marking nothing
  await page.evaluate(() => window.loop.settings.set({ startAtLogin: true, preview: false }));
  await app.close(); // a real quit: must exit although closeToTray is on
  await new Promise((r) => setTimeout(r, 2500)); // later than the clock-skew margin after the last message A saw
  await bPost("while closed");
  ({ app, page } = await relaunch());
  await expect(dmButton(B)).toHaveAttribute("data-unread", "true");
  await expect(dmButton(B).getByText("Có tin nhắn chưa đọc")).toBeVisible();
  await expect(page).toHaveTitle(/^\(\d+\) Loop$/);
  expect(await page.evaluate(() => window.loop.settings.get())).toMatchObject({ startAtLogin: true, preview: false, notifications: true, closeToTray: true });
  await hook(app, "setFocused", true);
  await dmButton(B).click();
  await expect(page.getByRole("log").getByText("while closed")).toBeVisible();
  await expect(dmButton(B)).not.toHaveAttribute("data-unread", "true");
  await page.evaluate(() => window.loop.settings.set({ startAtLogin: false, preview: true }));
});

async function relaunch() {
  const a = await _electron.launch({ args: [...FAKE_MEDIA, MAIN], env: launchEnv(userData) });
  const p = await a.firstWindow();
  await expect(p.getByRole("heading", { name: /Bạn bè|Cài đặt|.+/ }).first()).toBeVisible({ timeout: 30_000 });
  await hook(a, "setFocused", false); // the restored place may be a DM: keep it unread-able
  await expect(p.getByRole("navigation", { name: "Danh sách máy chủ" })).toBeVisible();
  return { app: a, page: p };
}

test.describe("tray, close-to-tray, single instance, quit", () => {
  let voz: string;
  test.beforeAll(async () => {
    await app.close().catch(() => undefined);
    voz = (await api<{ id: string }>(A.token, "POST", `/guilds/${guildId}/channels`, { name: "voz", type: "VOICE" })).id;
    ({ app, page, userData } = await launchAs(A, { args: FAKE_MEDIA }));
    await setFocused(true);
  });

  test("a tray icon exists; closing the window hides it and the app keeps running; the tray shows it again", async () => {
    expect(await hook(app, "tray")).toEqual({ exists: true });
    expect(await hook(app, "window")).toEqual({ exists: true, visible: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => hook(app, "window")).toEqual({ exists: true, visible: false });
    expect(await page.evaluate(() => 1 + 1)).toBe(2); // the renderer is alive behind the hidden window
    await hook(app, "trayClick");
    await expect.poll(() => hook(app, "window")).toEqual({ exists: true, visible: true });
  });

  test("a second launch exits at once and brings the first window forward", async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => hook<{ visible: boolean }>(app, "window").then((w) => w.visible)).toBe(false);
    const exe = await app.evaluate(() => process.execPath);
    const child = spawn(exe, [MAIN], { env: launchEnv(userData), stdio: "ignore" });
    const code = await new Promise<number | null>((resolve, reject) => {
      const t = setTimeout(() => (child.kill(), reject(new Error("second instance did not exit"))), 20_000);
      child.once("exit", (c) => (clearTimeout(t), resolve(c)));
    });
    expect(code).toBe(0);
    await expect.poll(() => hook<{ visible: boolean }>(app, "window").then((w) => w.visible)).toBe(true);
  });

  test("the notification click brings a hidden window back, the tray menu toggles notifications", async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await setFocused(null); // the real state: hidden = not looked at
    await bPost("to a hidden window");
    await expect.poll(async () => (await notices()).some((n) => n.body === "to a hidden window")).toBe(true);
    await hook(app, "clickNotification", `dm:${dmId}`);
    await expect.poll(() => hook<{ visible: boolean }>(app, "window").then((w) => w.visible)).toBe(true);
    await expect(page.getByRole("heading", { name: B.user.username })).toBeVisible();
    await hook(app, "trayItem", "notifications");
    expect(await hook(app, "settings")).toMatchObject({ notifications: false });
    await hook(app, "trayItem", "notifications");
    expect(await hook(app, "settings")).toMatchObject({ notifications: true });
  });

  test("a voice session survives a hidden window and is released when the app quits (tray > Thoát exits the process)", async () => {
    await setFocused(true);
    await rail().getByRole("button", { name: `Noti ${run}` }).click();
    await page.getByRole("button", { name: "Kênh thoại voz", exact: true }).click();
    await expect(page.getByRole("region", { name: "Đang trong cuộc gọi" }).getByText("Đã kết nối", { exact: true })).toBeVisible({ timeout: 20_000 });
    const inRoom = async () => (await api<{ participants: { userId: string }[] }>(B.token, "GET", `/channels/${voz}/voice`)).participants.some((p) => p.userId === A.user.id);
    await expect.poll(inRoom).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.waitForTimeout(4000);
    expect(await inRoom()).toBe(true); // hidden is not left
    const proc = app.process();
    const exited = new Promise<void>((r) => proc.once("exit", () => r()));
    await hook(app, "trayItem", "quit");
    await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error("did not quit")), 20_000))]);
    await expect.poll(inRoom, { timeout: 12_000 }).toBe(false);
  });
});

test("settings file holds only the four known keys", () => {
  const file = JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));
  expect(Object.keys(file).sort()).toEqual(["closeToTray", "notifications", "preview", "startAtLogin"]);
});
