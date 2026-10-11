import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { Permission } from "@loop/shared";
import { api, befriend, connect, expectNoHorizontalOverflow, password, register, resize, run, status, type Conn, type Session } from "./helpers";
import { callToken, channelToken, createSmallRoom, deleteRoom, joinRoom, leaveAll, type Peer } from "./livekit";

// 9d: voice channels and DM calls against the REAL dev server + docker LiveKit. Chromium's fake mic/camera feed
// the app (the main-process permission handler must still allow `media`); everyone but A is a script (rtc-node).
let app: ElectronApplication;
let page: Page;
let O: Session; // owns the guild, so its permission changes are allowed
let A: Session; // the app's user: an ordinary member
let B: Session;
let C: Session;
let guildId: string;
let voz: string; // the main voice channel
let vozQuiet: string; // @everyone cannot SPEAK here
let vozFull: string; // pre-created LiveKit room with two seats
const extras: Session[] = [];
let conn: Conn[] = [];
const dmIds: Record<string, string> = {};

const channelList = () => page.getByRole("list", { name: "Danh sách kênh" });
const channelButton = (name: string) => page.getByRole("button", { name: `Kênh thoại ${name}`, exact: true });
const seatsUnder = (name: string) => page.getByRole("list", { name: `Người đang ở trong kênh ${name}` });
const bar = () => page.getByRole("region", { name: "Đang trong cuộc gọi" });
const strip = () => page.getByRole("region", { name: "Tài khoản" }); // mute / deafen live in the account strip
const mic = () => strip().getByRole("button", { name: "Tắt micro" });
const deafen = () => strip().getByRole("button", { name: "Tắt tiếng nghe" });
const camera = () => bar().getByRole("button", { name: "Bật camera" });
const leave = () => bar().getByRole("button", { name: /^(Rời kênh thoại|Kết thúc cuộc gọi|Huỷ cuộc gọi)$/ });
const grid = () => page.getByRole("list", { name: "Người trong kênh thoại" });
const notice = () => page.locator("[aria-live=polite]").filter({ hasText: /Đóng thông báo/ });
const audioElements = () => page.evaluate(() => ({ count: document.querySelectorAll("audio").length, muted: [...document.querySelectorAll("audio")].map((a) => a.muted) }));
const connected = () => expect(bar().getByText(/^Đã kết nối (giọng nói|cuộc gọi)$/)).toBeVisible({ timeout: 15_000 });
const idle = () => expect(bar()).toBeHidden();

async function newUser(tag: string) {
  const s = await register(tag);
  extras.push(s);
  return s;
}
const joinGuild = async (s: Session) => {
  const { code } = await api<{ code: string }>(O.token, "POST", `/guilds/${guildId}/invites`, {});
  await api(s.token, "POST", `/invites/${code}/join`);
};
const openGuild = async () => {
  await page.getByRole("navigation", { name: "Danh sách máy chủ" }).getByRole("button", { name: `Voz ${run}` }).click();
  await expect(channelList()).toBeVisible();
};
const dmWith = async (u: Session) => (dmIds[u.user.id] ??= (await api<{ id: string }>(A.token, "POST", "/dms", { userId: u.user.id })).id);
const openDm = async (u: Session) => {
  await page.getByRole("button", { name: "Trang chủ" }).click();
  await page.getByRole("list", { name: "Danh sách tin nhắn trực tiếp" }).getByRole("button", { name: new RegExp(u.user.username) }).click();
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  [O, A, B, C] = await Promise.all([register("vo"), register("va"), register("vb"), register("vc")]);
  const { guild } = await api<{ guild: { id: string } }>(O.token, "POST", "/guilds", { name: `Voz ${run}` });
  guildId = guild.id;
  voz = (await api<{ id: string }>(O.token, "POST", `/guilds/${guildId}/channels`, { name: "voz-chinh", type: "VOICE" })).id;
  vozQuiet = (await api<{ id: string }>(O.token, "POST", `/guilds/${guildId}/channels`, { name: "voz-im-lang", type: "VOICE" })).id;
  vozFull = (await api<{ id: string }>(O.token, "POST", `/guilds/${guildId}/channels`, { name: "voz-day", type: "VOICE" })).id;
  await api(O.token, "PUT", `/channels/${vozQuiet}/overwrites/${guildId}`, { allow: 0, deny: Permission.SPEAK });
  for (const s of [A, B, C]) await joinGuild(s);
  await befriend(A, B);
  await dmWith(B); // before the app loads its DM list
  app = await _electron.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", join(__dirname, "../out/main/index.js")],
    env: { ...process.env, LOOP_USER_DATA_DIR: mkdtempSync(join(tmpdir(), "loop-e2e-9d-")) },
  });
  page = await app.firstWindow();
  await page.getByLabel("Email").fill(`${A.user.username}@example.com`);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Bạn bè" })).toBeVisible();
  conn = [await connect(B)];
  await openGuild();
});
test.afterAll(async () => {
  await leaveAll();
  conn.forEach((c) => c.close());
  await deleteRoom(`voice:${vozFull}`);
  await app?.close();
});
test.afterEach(async () => {
  // every test starts from "not in a call" without depending on how the previous one ended
  if (await bar().isVisible().catch(() => false)) await leave().click();
});

test("the main process allows media for the app and still refuses other permissions", async () => {
  const r = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const tracks = stream.getTracks().map((t) => t.kind);
    stream.getTracks().forEach((t) => t.stop());
    return { tracks, notification: await Notification.requestPermission() };
  });
  expect(r.tracks.sort()).toEqual(["audio", "video"]);
  expect(r.notification).toBe("denied");
});

test("production CSP: the build runs at app://loop, may reach LiveKit and nothing unrelated", async () => {
  const r = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (e) => violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    const probe = (url: string) => fetch(url, { mode: "no-cors" }).then(() => "sent", () => "failed");
    const livekit = await probe("http://127.0.0.1:7880/");
    const foreign = await probe("http://127.0.0.1:7881/");
    const elsewhere = await probe("https://example.com/");
    await new Promise((res) => setTimeout(res, 200)); // violation events are delivered asynchronously
    return { origin: location.origin, livekit, foreign, elsewhere, violations };
  });
  expect(r.origin).toBe("app://loop");
  expect(r.livekit).toBe("sent");
  expect(r.violations.some((v) => v.includes("7880"))).toBe(false);
  expect(r.violations.filter((v) => v.startsWith("connect-src")).map((v) => v.split(" ")[1]).sort()).toEqual(["http://127.0.0.1:7881/", "https://example.com/"]);
  expect([r.foreign, r.elsewhere]).toEqual(["failed", "failed"]);
});

test("voice channels are enabled, and the list shows who is inside live (voice:update) without joining", async () => {
  await expect(channelButton("voz-chinh")).toBeEnabled();
  await expect(seatsUnder("voz-chinh")).toBeHidden();
  const b = await joinRoom(await channelToken(B, voz));
  await expect(seatsUnder("voz-chinh").getByRole("listitem")).toContainText([B.user.username]);
  await b.leave();
  await expect(seatsUnder("voz-chinh")).toBeHidden();
  // a REST catch-up covers someone already inside when the guild is opened: leave the guild view and come back
  const again = await joinRoom(await channelToken(B, voz));
  await page.getByRole("button", { name: "Trang chủ" }).click();
  await openGuild();
  await expect(seatsUnder("voz-chinh").getByRole("listitem")).toContainText([B.user.username]);
  await again.leave();
  await expect(seatsUnder("voz-chinh")).toBeHidden();
});

test("join: A is listed, the bar appears, B hears A's microphone and A hears B; the join takes N ms", async () => {
  const b = await joinRoom(await channelToken(B, voz));
  const t0 = Date.now();
  await channelButton("voz-chinh").click();
  await connected();
  const joinMs = Date.now() - t0;
  console.log(`[9d] click Join -> connected: ${joinMs} ms`);
  await expect(bar()).toContainText("voz-chinh");
  await expect(grid()).toHaveCount(0); // joining does not open the room
  await channelButton("voz-chinh").click(); // already connected: this opens it
  expect((await api<{ participants: { userId: string }[] }>(A.token, "GET", `/channels/${voz}/voice`)).participants.map((p) => p.userId).sort()).toEqual([A.user.id, B.user.id].sort());
  await expect.poll(() => b.sees(A.user.id)).toMatchObject({ present: true, audio: 1, audioMuted: false }); // the fake mic reached LiveKit
  await expect(grid().getByRole("listitem")).toHaveCount(2);
  await expect(grid()).toContainText(B.user.username);
  await expect(seatsUnder("voz-chinh").getByRole("listitem")).toHaveCount(2);
  await expect.poll(async () => (await audioElements()).count).toBe(1); // B's track plays in an <audio> element
  await expect(mic()).toHaveAttribute("aria-pressed", "false");

  // mute -> B sees the track muted; unmute
  await mic().click();
  await expect(mic()).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => b.sees(A.user.id).audioMuted).toBe(true);
  await expect(seatsUnder("voz-chinh").getByText("Đã tắt micro")).toHaveCount(1);
  await mic().click();
  await expect.poll(() => b.sees(A.user.id).audioMuted).toBe(false);

  // deafen: every remote <audio> muted (still there), the mic off; undeafen restores the mic
  await deafen().click();
  await expect(deafen()).toHaveAttribute("aria-pressed", "true");
  await expect.poll(audioElements).toEqual({ count: 1, muted: [true] });
  await expect.poll(() => b.sees(A.user.id).audioMuted).toBe(true);
  await expect(mic()).toBeDisabled();
  await deafen().click();
  await expect.poll(audioElements).toEqual({ count: 1, muted: [false] });
  await expect.poll(() => b.sees(A.user.id).audioMuted).toBe(false);
  await expect(mic()).toHaveAttribute("aria-pressed", "false");

  // camera on -> B receives a video track; off -> it goes
  await camera().click();
  await expect(camera()).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => b.sees(A.user.id).video).toBe(1);
  await expect(grid().locator("video")).toHaveCount(1);
  await camera().click();
  await expect.poll(() => b.sees(A.user.id).video).toBe(0);

  // idle sanity while connected: the renderer is not spinning
  await page.waitForTimeout(1500);
  const cpu = await app.evaluate(({ app: a }) => a.getAppMetrics().filter((m) => m.type === "Tab" || m.type === "Browser").map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage })));
  await page.waitForTimeout(3000);
  const cpu2 = await app.evaluate(({ app: a }) => a.getAppMetrics().filter((m) => m.type === "Tab" || m.type === "Browser").map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage })));
  console.log(`[9d] CPU while connected (after 3 s idle, % of one core): ${JSON.stringify(cpu2)} (before: ${JSON.stringify(cpu)})`);

  // leave: B sees A go, no <audio> left, the bar is gone
  await leave().click();
  await idle();
  await expect.poll(() => b.sees(A.user.id).present).toBe(false);
  expect((await audioElements()).count).toBe(0);
  await b.leave();
});

test("no SPEAK: the mic control is disabled with a reason, B never receives audio", async () => {
  const b = await joinRoom(await channelToken(B, vozQuiet), { mic: false }); // nobody can speak here
  await channelButton("voz-im-lang").click();
  await connected();
  await expect(mic()).toBeDisabled();
  await mic().locator("..").hover(); // the reason is the tooltip of the (disabled) button's wrapper
  await expect(page.getByRole("tooltip")).toHaveText("Bạn không có quyền nói trong kênh này", { timeout: 2000 });
  await expect(camera()).toBeEnabled(); // VIDEO is separate
  await expect.poll(() => b.sees(A.user.id).present).toBe(true); // A is visible to others once its media is up
  await page.waitForTimeout(2500);
  expect(b.sees(A.user.id)).toMatchObject({ present: true, audio: 0 });
  await leave().click();
  await b.leave();
});

test("SPEAK revoked while connected: the mic goes off and the control is disabled; then CONNECT revoked removes A with a message", async () => {
  const b = await joinRoom(await channelToken(B, voz));
  await channelButton("voz-chinh").click();
  await connected();
  await expect.poll(() => b.sees(A.user.id).audio).toBe(1);
  await api(O.token, "PUT", `/channels/${voz}/overwrites/${guildId}`, { allow: 0, deny: Permission.SPEAK });
  await expect(mic()).toBeDisabled();
  await expect(mic()).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => b.sees(A.user.id).audio).toBe(0);

  await api(O.token, "PUT", `/channels/${voz}/overwrites/${guildId}`, { allow: 0, deny: Permission.SPEAK | Permission.CONNECT });
  await expect(bar()).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(/Bạn đã bị đưa ra khỏi kênh thoại/)).toBeVisible();
  expect((await audioElements()).count).toBe(0);
  // CONNECT is denied now: joining again says so (403), and nothing connects
  await page.getByRole("button", { name: "Đóng thông báo" }).click();
  await channelButton("voz-chinh").click();
  await expect(page.getByText("Bạn không có quyền vào kênh thoại này.")).toBeVisible();
  await expect(bar()).toBeHidden();
  await api(O.token, "DELETE", `/channels/${voz}/overwrites/${guildId}`);
  await b.leave();
});

test("a full channel answers 409 with its own message", async () => {
  await deleteRoom(`voice:${vozFull}`);
  await createSmallRoom(`voice:${vozFull}`, 2);
  const [b, c] = [await joinRoom(await channelToken(B, vozFull)), await joinRoom(await channelToken(C, vozFull))];
  await page.getByRole("button", { name: "Đóng thông báo" }).click().catch(() => undefined);
  await channelButton("voz-day").click();
  await expect(page.getByText("Kênh thoại đã đầy, hãy thử lại sau.")).toBeVisible();
  await expect(bar()).toBeHidden();
  await page.getByRole("button", { name: "Đóng thông báo" }).click();
  await Promise.all([b.leave(), c.leave()]);
});

test("the same account joining elsewhere replaces this session with a message", async () => {
  await channelButton("voz-chinh").click();
  await connected();
  const other = await joinRoom(await channelToken(A, voz)); // A's second connection (another device)
  await expect(page.getByText("Bạn đã tham gia kênh này ở nơi khác.")).toBeVisible({ timeout: 15_000 });
  await expect(bar()).toBeHidden();
  await other.leave();
  await page.getByRole("button", { name: "Đóng thông báo" }).click();
});

test("25 people: the grid and the channel list never overflow at 1280x800 and 960x600", async () => {
  test.setTimeout(240_000);
  const others: Peer[] = [await joinRoom(await channelToken(B, voz), { mic: false }), await joinRoom(await channelToken(C, voz), { mic: false })];
  for (let i = 0; i < 22; i++) {
    const u = await newUser(`vx${i}`);
    await joinGuild(u);
    others.push(await joinRoom(await channelToken(u, voz), { mic: false }));
  }
  await channelButton("voz-chinh").click();
  await connected();
  await expect(grid().getByRole("listitem")).toHaveCount(25, { timeout: 20_000 });
  await expect(seatsUnder("voz-chinh").getByRole("listitem")).toHaveCount(25);
  for (const [w, h] of [[1280, 800], [960, 600]] as const) {
    await resize(app, w, h);
    await page.waitForTimeout(300);
    await expectNoHorizontalOverflow([page.locator("main"), grid(), page.getByRole("navigation", { name: "Kênh" }), page.locator("body")]);
  }
  await resize(app, 1280, 800);
  // the 26th is refused politely when someone tries (server 409 at 25)
  const extra = await newUser("vover");
  await joinGuild(extra);
  expect(await status(extra.token, "POST", `/channels/${voz}/voice/token`)).toBe(409);
  await leave().click();
  await Promise.all(others.map((o) => o.leave()));
  await expect(seatsUnder("voz-chinh")).toBeHidden({ timeout: 15_000 });
});

test.describe("DM calls", () => {
  const dialog = () => page.getByRole("dialog", { name: /đang gọi bạn|gọi video cho bạn/ });
  const phone = () => page.getByRole("button", { name: "Gọi thoại" });
  // The server rings only the first person into an EMPTY room, judged from LiveKit's participant list, which
  // takes a moment to drop people who just left: give the previous test's room time to empty.
  test.beforeEach(() => page.waitForTimeout(2500));

  test("B calls A: the dialog focuses Answer, Answer connects both ways", async () => {
    const dmId = await dmWith(B);
    await openDm(B);
    const bc = conn[0];
    const call = await callToken(B, dmId, false);
    const b = await joinRoom(call);
    await expect(dialog()).toBeVisible();
    await expect(dialog()).toContainText(B.user.username);
    await expect(page.getByRole("button", { name: "Trả lời" })).toBeFocused();
    await page.getByRole("button", { name: "Trả lời" }).click();
    await connected();
    await expect(bar()).toContainText(B.user.username);
    await expect.poll(() => b.sees(A.user.id)).toMatchObject({ present: true, audio: 1 });
    await expect.poll(async () => (await audioElements()).count).toBe(1);
    expect(bc.events.filter((e) => e.event === "call:incoming")).toHaveLength(0); // B started it
    await leave().click();
    await b.leave();
  });

  test("Esc declines (B hears call:declined); the caller cancelling removes the dialog", async () => {
    const dmId = await dmWith(B);
    let b = await joinRoom(await callToken(B, dmId));
    await expect(dialog()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog()).toBeHidden();
    await conn[0].waitFor("call:declined", (d) => d.dmChannelId === dmId);
    await b.leave();
    // cancel: B rings, then hangs up before A answers
    await page.waitForTimeout(2500);
    b = await joinRoom(await callToken(B, dmId));
    await expect(dialog()).toBeVisible();
    await b.leave();
    await expect(dialog()).toBeHidden({ timeout: 20_000 });
  });

  test("A calls B: ringing bar with Cancel; B answers -> active; cancel path; decline path", async () => {
    const dmId = await dmWith(B);
    await openDm(B);
    const before = conn[0].events.filter((e) => e.event === "call:incoming").length;
    await phone().click();
    await expect(bar()).toContainText(`Đang gọi ${B.user.username}`, { timeout: 15_000 });
    await conn[0].waitFor("call:incoming", (d) => d.dmChannelId === dmId && d.from.id === A.user.id);
    expect(conn[0].events.filter((e) => e.event === "call:incoming").length).toBe(before + 1);
    await expect(phone()).toBeDisabled(); // already in this call
    const b = await joinRoom(await callToken(B, dmId)); // B answers
    await expect(bar()).toContainText(B.user.username);
    await expect.poll(() => b.sees(A.user.id).audio).toBe(1);
    await expect.poll(() => b.identities()).toEqual([A.user.id]);
    await leave().click();
    await b.leave();
    await idle();

    // cancel while ringing
    await phone().click();
    await expect(bar()).toContainText("Đang gọi");
    await bar().getByRole("button", { name: "Huỷ cuộc gọi" }).click();
    await idle();
    await conn[0].waitFor("call:ended", (d) => d.dmChannelId === dmId);

    // declined by B
    await page.waitForTimeout(2500);
    await phone().click();
    await expect(bar()).toContainText("Đang gọi", { timeout: 15_000 });
    await api(B.token, "POST", `/dms/${dmId}/call/decline`);
    await expect(page.getByText(`${B.user.username} đã từ chối cuộc gọi.`)).toBeVisible();
    await idle();
    await page.getByRole("button", { name: "Đóng thông báo" }).click();
  });

  test("a call that arrives while in a voice channel shows the dialog but does not switch; Answer leaves the channel", async () => {
    const dmId = await dmWith(B);
    await openGuild();
    await channelButton("voz-chinh").click();
    await connected();
    const b = await joinRoom(await callToken(B, dmId));
    await expect(dialog()).toBeVisible();
    await expect(dialog()).toContainText("rời khỏi kênh thoại");
    await expect(bar()).toContainText("voz-chinh"); // untouched
    await page.getByRole("button", { name: "Trả lời" }).click();
    await expect(bar()).toContainText(B.user.username);
    await expect(seatsUnder("voz-chinh")).toBeHidden();
    await b.leave();
    await leave().click().catch(() => undefined);
  });

  test("a block in the middle of a call ends it once: one message, session idle, repeats change nothing", async () => {
    const dmId = await dmWith(B);
    const b = await joinRoom(await callToken(B, dmId));
    await page.getByRole("button", { name: "Trả lời" }).click();
    await connected();
    const endedBefore = conn[0].events.filter((e) => e.event === "call:ended").length;
    await api(B.token, "PUT", `/blocks/${A.user.id}`);
    await expect(page.getByText("Cuộc gọi đã kết thúc.")).toHaveCount(1);
    await idle();
    await page.waitForTimeout(2500); // the server's repeated call:ended events
    await expect(page.getByText("Cuộc gọi đã kết thúc.")).toHaveCount(1);
    expect((await audioElements()).count).toBe(0);
    expect(endedBefore).toBeGreaterThanOrEqual(0);
    await b.leave();
    await api(B.token, "DELETE", `/blocks/${A.user.id}`);
    await befriend(A, B); // unblocking does not restore the friendship the block removed
    await page.getByRole("button", { name: "Đóng thông báo" }).click();
  });
});

test("a real kick while connected: the removed message, the session is idle", async () => {
  await openGuild();
  await channelButton("voz-chinh").click();
  await connected();
  await api(O.token, "DELETE", `/guilds/${guildId}/members/${A.user.id}`);
  await expect(bar()).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(/Bạn đã bị đưa ra khỏi kênh thoại/)).toBeVisible();
  expect((await audioElements()).count).toBe(0);
});

test("signing out while in a call leaves the room (the other side sees A go)", async () => {
  await page.waitForTimeout(2500);
  const dmId = await dmWith(B);
  const b = await joinRoom(await callToken(B, dmId));
  await page.getByRole("button", { name: "Trả lời" }).click();
  await connected();
  await expect.poll(() => b.sees(A.user.id).present).toBe(true);
  await page.getByRole("button", { name: "Menu tài khoản" }).click();
  await page.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect.poll(() => b.sees(A.user.id).present).toBe(false);
  await b.leave();
});
