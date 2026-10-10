import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { io, type Socket } from "socket.io-client";

// 9b: servers + text chat against the REAL dev server (port 3000) + docker. "Other users" are API/socket scripts,
// so one Electron window is enough. Runs on the built app (origin app://loop) unless ELECTRON_RENDERER_URL points
// at a running Vite dev server.
const API = "http://localhost:3000";
const run = Date.now().toString(36);
const password = "correct-horse-battery";

type Session = { token: string; user: { id: string; username: string } };
type Msg = { id: string; channelId: string; content: string; seq: string };

async function api<T = unknown>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}
async function register(tag: string): Promise<Session> {
  const username = `${tag}_${run}`.slice(0, 32);
  const r = await api<{ accessToken: string; user: Session["user"] }>(null, "POST", "/auth/register", { email: `${username}@example.com`, username, password });
  return { token: r.accessToken, user: r.user };
}
const post = (s: Session, channelId: string, content: string) => api<Msg>(s.token, "POST", `/channels/${channelId}/messages`, { content });

/** A socket.io user that records every event it gets. */
async function listen(s: Session, channelId: string) {
  const events: { event: string; data: { id: string; content?: string } }[] = [];
  const socket: Socket = io(API, { auth: { token: s.token }, transports: ["websocket"] });
  socket.onAny((event, data) => events.push({ event, data }));
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", reject);
  });
  const ack = await socket.emitWithAck("channel:subscribe", { channelId });
  expect(ack).toEqual({ ok: true });
  const waitFor = (event: string, pred: (d: { id: string; content?: string }) => boolean) =>
    expect.poll(() => events.some((e) => e.event === event && pred(e.data)), { timeout: 10_000 }).toBe(true);
  return { socket, events, waitFor };
}

let app: ElectronApplication;
let page: Page;
let A: Session; // the person using the app
let B: Session; // a friend scripted through the API
let C: Session; // owner of another server
const wsUrls: string[] = [];

const log = () => page.getByRole("log");
const scroller = () => log().locator("..");
const composer = () => page.getByRole("textbox", { name: /^Nhắn vào #/ });
const rail = () => page.getByRole("navigation", { name: "Danh sách máy chủ" });
const channelList = () => page.getByRole("list", { name: "Danh sách kênh" });
const messageText = (text: string) => log().getByText(text, { exact: true });
const resize = (w: number, h: number) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);

/** No horizontal overflow anywhere that matters (columns, message list). */
async function expectNoHorizontalOverflow(locators: Locator[]) {
  for (const l of locators) {
    const { scrollWidth, clientWidth } = await l.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(scrollWidth, await l.evaluate((el) => el.outerHTML.slice(0, 80))).toBeLessThanOrEqual(clientWidth);
  }
}
async function expectEllipsis(l: Locator) {
  const r = await l.evaluate((el) => ({ overflow: getComputedStyle(el).textOverflow, cut: el.scrollWidth > el.clientWidth }));
  expect(r).toEqual({ overflow: "ellipsis", cut: true });
}

/** Frame times (ms) while scrolling the message list from top to bottom, 400px per frame. */
const sweepFrames = () =>
  scroller().evaluate(
    (el) =>
      new Promise<number[]>((resolve) => {
        const times: number[] = [];
        let last = performance.now();
        el.scrollTop = 0;
        const step = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          el.scrollTop += 400;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) resolve(times.slice(1));
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
const percentile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))];

/** backdrop-filter and the alpha of the background colour, as the browser computes them. */
const surface = (l: Locator) =>
  l.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { blur: cs.backdropFilter, alpha: Number(cs.backgroundColor.match(/\/\s*([\d.]+)\)/)?.[1] ?? 1) };
  });
async function expectGlass(l: Locator) {
  const { blur, alpha } = await surface(l);
  expect(blur).toMatch(/^blur\(\d+px\)/);
  expect(alpha).toBeLessThan(1);
}
async function expectSolid(l: Locator) {
  expect(await surface(l)).toEqual({ blur: "none", alpha: 1 });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  [A, B, C] = await Promise.all([register("a"), register("b"), register("c")]);
  app = await _electron.launch({
    args: [join(__dirname, "../out/main/index.js")],
    env: { ...process.env, LOOP_USER_DATA_DIR: mkdtempSync(join(tmpdir(), "loop-e2e-chat-")) },
  });
  page = await app.firstWindow();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketCreated", (e) => wsUrls.push(e.url));
  (globalThis as { cdp?: typeof cdp }).cdp = cdp;
  await page.getByLabel("Email").fill(`${A.user.username}@example.com`);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Bạn bè" })).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
});

let guildId = "";
let generalId = "";
let friend: Awaited<ReturnType<typeof listen>>;
const longName = `Nhóm bạn thân Đà Nẵng ${run} ữặễỹỵ `.padEnd(100, "ấ");

test("create a server (validation, long name), empty channel, create channel, duplicate name", async () => {
  expect(await page.evaluate(() => location.origin)).toMatch(process.env.ELECTRON_RENDERER_URL ? /localhost:5173/ : /^app:\/\/loop$/);
  await rail().getByRole("button", { name: "Tạo máy chủ" }).click();
  const dialog = page.getByRole("dialog", { name: "Tạo máy chủ" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Tên máy chủ")).toBeFocused();
  await dialog.getByRole("button", { name: "Tạo máy chủ" }).click();
  await expect(dialog.getByText("Vui lòng điền mục này.")).toBeVisible();
  await page.keyboard.press("Escape"); // native dialog: Esc closes, focus returns to the opener
  await expect(dialog).toBeHidden();
  await expect(rail().getByRole("button", { name: "Tạo máy chủ" })).toBeFocused();

  await rail().getByRole("button", { name: "Tạo máy chủ" }).click();
  await dialog.getByLabel("Tên máy chủ").fill(longName);
  await dialog.getByRole("button", { name: "Tạo máy chủ" }).click();
  await expect(dialog).toBeHidden();
  await expect(rail().getByRole("button", { name: longName })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Đây là đầu kênh #general" })).toBeHidden(); // it is a <p>, not a heading
  await expect(log().getByText("Đây là đầu kênh #general")).toBeVisible();
  await expectEllipsis(page.getByRole("button", { name: `Tuỳ chọn máy chủ ${longName}` }).locator("span").first());

  const guilds = await api<{ id: string; name: string }[]>(A.token, "GET", "/guilds");
  guildId = guilds.find((g) => g.name === longName.trim())!.id;
  generalId = (await api<{ channels: { id: string; name: string }[] }>(A.token, "GET", `/guilds/${guildId}`)).channels[0].id;

  await page.getByRole("button", { name: /^Tuỳ chọn máy chủ/ }).click();
  await page.getByRole("button", { name: "Tạo kênh" }).click();
  const create = page.getByRole("dialog", { name: "Tạo kênh" });
  await create.getByLabel("Tên kênh").fill("Thảo luận");
  await create.getByRole("button", { name: "Tạo kênh" }).click();
  await expect(create.getByText("Chỉ dùng chữ thường không dấu, số, dấu - và dấu _.")).toBeVisible();
  await create.getByLabel("Tên kênh").fill("General");
  await expect(create.getByLabel("Tên kênh")).toHaveValue("general");
  await create.getByRole("button", { name: "Tạo kênh" }).click();
  await expect(create.getByText("Máy chủ đã có kênh tên này. Chọn tên khác nhé.")).toBeVisible();
  await create.getByLabel("Tên kênh").fill("tro chuyen");
  await create.getByRole("button", { name: "Tạo kênh" }).click();
  await expect(create).toBeHidden();
  await expect(channelList().getByRole("button", { name: "tro-chuyen", exact: true })).toHaveAttribute("aria-current", "page");
  await channelList().getByRole("button", { name: "general", exact: true }).click();
});

test("invite with copy feedback; B joins by API; live messages both ways; IME Enter does not send", async () => {
  await page.getByRole("button", { name: /^Tuỳ chọn máy chủ/ }).click();
  await page.getByRole("button", { name: "Mời bạn bè" }).click();
  const dialog = page.getByRole("dialog", { name: /^Mời bạn bè vào/ });
  const code = (await dialog.getByRole("status", { name: "Mã mời" }).or(dialog.locator("output")).first().innerText()).trim();
  expect(code).toMatch(/^[A-Za-z0-9_-]{8}$/);
  await dialog.getByRole("button", { name: "Sao chép" }).click();
  await expect(dialog.getByRole("button", { name: "Đã sao chép" })).toBeVisible();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(code);
  await dialog.getByRole("button", { name: "Đóng" }).click();

  await api(B.token, "POST", `/invites/${code}/join`);
  friend = await listen(B, generalId);

  await post(B, generalId, "Chào cả nhà, mình là B đây!");
  await expect(messageText("Chào cả nhà, mình là B đây!")).toBeVisible();

  await composer().fill("Chào B, mình nhận được rồi");
  await composer().press("Enter");
  await friend.waitFor("message:new", (d) => d.content === "Chào B, mình nhận được rồi");
  await expect(messageText("Chào B, mình nhận được rồi")).toHaveCount(1); // pending + own echo never doubled
  await expect(composer()).toHaveValue("");

  // Shift+Enter is a newline; the Enter that confirms a Telex composition (isComposing / keyCode 229) is not a send
  await composer().fill("Tiếng Việt");
  await composer().press("Shift+Enter");
  await composer().evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(500);
  await expect(composer()).toHaveValue("Tiếng Việt\n");
  expect(friend.events.filter((e) => e.event === "message:new" && e.data.content?.startsWith("Tiếng Việt"))).toHaveLength(0);
  await composer().fill("");
});

test("edit and delete: A's changes reach B, B's changes reach A", async () => {
  const mine = log().getByRole("article").filter({ hasText: "Chào B, mình nhận được rồi" });
  await mine.hover();
  await mine.getByRole("button", { name: "Sửa tin nhắn" }).click();
  const editor = page.getByRole("textbox", { name: "Sửa tin nhắn" });
  await editor.press("Escape");
  await expect(editor).toBeHidden();
  await mine.hover();
  await mine.getByRole("button", { name: "Sửa tin nhắn" }).click();
  await editor.fill("Chào B, đã sửa nè");
  await editor.press("Enter");
  await friend.waitFor("message:update", (d) => d.content === "Chào B, đã sửa nè");
  await expect(log().getByRole("article").filter({ hasText: "Chào B, đã sửa nè" }).getByText("(đã chỉnh sửa)")).toBeVisible();

  const edited = log().getByRole("article").filter({ hasText: "Chào B, đã sửa nè" });
  await edited.hover();
  await edited.getByRole("button", { name: "Xoá tin nhắn" }).click();
  const confirm = page.getByRole("dialog", { name: "Xoá tin nhắn?" });
  await expect(confirm.getByRole("button", { name: "Huỷ" })).toBeFocused();
  await confirm.getByRole("button", { name: "Xoá", exact: true }).click();
  await expect(messageText("Chào B, đã sửa nè")).toHaveCount(0);
  const deletedId = friend.events.find((e) => e.event === "message:update" && e.data.content === "Chào B, đã sửa nè")!.data.id;
  await friend.waitFor("message:delete", (d) => d.id === deletedId);

  const theirs = await post(B, generalId, "Tin của B sắp được sửa");
  await expect(messageText("Tin của B sắp được sửa")).toBeVisible();
  await api(B.token, "PATCH", `/messages/${theirs.id}`, { content: "Tin của B đã sửa" });
  await expect(messageText("Tin của B đã sửa")).toBeVisible();
  // the owner may delete anyone's message (MANAGE_MESSAGES): the button is offered
  const theirRow = log().getByRole("article").filter({ hasText: "Tin của B đã sửa" });
  await theirRow.hover();
  await expect(theirRow.getByRole("button", { name: "Xoá tin nhắn" })).toBeVisible();
  await expect(theirRow.getByRole("button", { name: "Sửa tin nhắn" })).toHaveCount(0);
  await api(B.token, "DELETE", `/messages/${theirs.id}`);
  await expect(messageText("Tin của B đã sửa")).toHaveCount(0);
});

test("failed send keeps the text with retry; retry sends it once", async () => {
  await page.route("**/channels/*/messages", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  await composer().fill("Tin này sẽ lỗi lần đầu");
  await composer().press("Enter");
  const failed = log().getByRole("article", { name: "Gửi thất bại" });
  await expect(failed).toContainText("Tin này sẽ lỗi lần đầu");
  await page.unroute("**/channels/*/messages");
  await failed.getByRole("button", { name: "Gửi lại" }).click();
  await friend.waitFor("message:new", (d) => d.content === "Tin này sẽ lỗi lần đầu");
  await expect(messageText("Tin này sẽ lỗi lần đầu")).toHaveCount(1);
  await expect(log().getByRole("article", { name: "Gửi thất bại" })).toHaveCount(0);
});

test("reconnect catch-up: messages posted while offline appear exactly once, in order", async () => {
  const cdp = (globalThis as unknown as { cdp: import("@playwright/test").CDPSession }).cdp;
  const network = (offline: boolean) => cdp.send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await network(true);
  await expect(page.getByText("Mất kết nối mạng.")).toBeVisible();
  await page.waitForTimeout(1500);
  const missed = Array.from({ length: 7 }, (_, i) => `Lúc offline số ${i + 1}`);
  for (const text of missed) await post(B, generalId, text);
  await page.waitForTimeout(1500);
  await expect(messageText(missed[0])).toHaveCount(0); // really cut off: nothing arrived live
  await network(false);
  for (const text of missed) await expect(messageText(text)).toHaveCount(1, { timeout: 20_000 });
  const order = await log().getByRole("article").allInnerTexts();
  const positions = missed.map((m) => order.findIndex((t) => t.includes(m)));
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  await expect(page.getByText("Mất kết nối tới máy chủ")).toHaveCount(0);
});

test("history: 130 seeded messages page in on scroll without jumping, down to the channel start", async () => {
  test.setTimeout(120_000);
  const channel = await api<{ id: string }>(A.token, "POST", `/guilds/${guildId}/channels`, { name: "lich-su", type: "TEXT" });
  for (let i = 1; i <= 130; i++) await post(B, channel.id, `Lịch sử #${i}`);
  await rail().getByRole("button", { name: longName }).click(); // reopening a server refetches its channels
  await channelList().getByRole("button", { name: "lich-su", exact: true }).click();
  await expect(messageText("Lịch sử #130")).toBeVisible();
  await expect(log().getByRole("article")).toHaveCount(50);
  // pinned to the bottom after the first load
  const atBottom = await scroller().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  expect(atBottom).toBeLessThan(2);

  const jumps: number[] = [];
  for (const expected of [100, 130]) {
    // the oldest message's TEXT is the anchor (its row may lose the author header once it gets grouped)
    const anchorText = (await log().getByRole("article").first().innerText()).split("\n").pop()!;
    const anchor = messageText(anchorText);
    // scroll to the top and read the anchor's position in the same task, before the older page can arrive
    const before = await anchor.evaluate((el) => {
      el.closest('[role="log"]')!.parentElement!.scrollTop = 0;
      return el.getBoundingClientRect().top;
    });
    await expect(log().getByRole("article")).toHaveCount(expected);
    const after = await anchor.evaluate((el) => el.getBoundingClientRect().top);
    jumps.push(Math.round(after - before));
  }
  console.log(`history: anchor moved by ${jumps.join(", ")} px after prepends (0 = no jump)`);
  for (const j of jumps) expect(Math.abs(j)).toBeLessThanOrEqual(1);
  await expect(log().getByText("Đây là đầu kênh #lich-su")).toBeVisible();
  // new messages while scrolled up: a pill instead of a jump
  await scroller().evaluate((el) => (el.scrollTop = 0));
  await post(B, channel.id, "Tin mới khi đang đọc tin cũ");
  const pill = page.getByRole("button", { name: "1 tin nhắn mới" });
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(pill).toBeHidden();
  await expect(messageText("Tin mới khi đang đọc tin cũ")).toBeInViewport();
});

test("performance with 1100 loaded messages", async () => {
  test.setTimeout(300_000);
  const channel = await api<{ id: string }>(A.token, "POST", `/guilds/${guildId}/channels`, { name: "hieu-nang", type: "TEXT" });
  const texts = Array.from({ length: 1100 }, (_, i) => `Tin hiệu năng ${i + 1}: xem https://example.com/${i} nhé, có dấu tiếng Việt ạ ơ ư.`);
  for (let i = 0; i < texts.length; i += 20) await Promise.all(texts.slice(i, i + 20).map((t) => post(B, channel.id, t)));
  await rail().getByRole("button", { name: longName }).click();
  await channelList().getByRole("button", { name: "hieu-nang", exact: true }).click();
  await expect(log().getByRole("article")).toHaveCount(50);

  const pageTimes: number[] = [];
  for (let n = 100; n <= 1100; n += 50) {
    const t0 = Date.now();
    await scroller().evaluate((el) => (el.scrollTop = 0));
    await expect(log().getByRole("article")).toHaveCount(Math.min(n, 1100), { timeout: 15_000 });
    pageTimes.push(Date.now() - t0);
  }
  // scroll sweep: frame times while scrolling through all 1100 rows
  const frames = await sweepFrames();
  // a live message with 1100 rows mounted: time from the event to the DOM (React commit), measured in the page
  await scroller().evaluate((el) => (el.scrollTop = el.scrollHeight));
  const waitLive = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const logEl = document.querySelector('[role="log"]')!;
        let start = 0;
        const obs = new MutationObserver(() => {
          if (logEl.textContent?.includes("Tin trực tiếp đo thời gian")) {
            obs.disconnect();
            resolve(performance.now() - start);
          }
        });
        obs.observe(logEl, { childList: true, subtree: true, characterData: true });
        start = performance.now();
      }),
  );
  const tPost = Date.now();
  await post(B, channel.id, "Tin trực tiếp đo thời gian");
  const liveMs = await waitLive;
  const endToEnd = Date.now() - tPost;
  const sorted = [...frames].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.floor(q * (sorted.length - 1))].toFixed(1);
  const summary = {
    pagesMs: { median: [...pageTimes].sort((a, b) => a - b)[Math.floor(pageTimes.length / 2)], max: Math.max(...pageTimes), last: pageTimes.at(-1) },
    scrollFrames: { count: frames.length, p50: p(0.5), p95: p(0.95), max: p(1) },
    liveMessage: { observedInPageMs: Math.round(liveMs), postToVisibleMs: endToEnd },
  };
  console.log(`performance (1100 messages): ${JSON.stringify(summary)}`);
  expect(Number(p(0.95))).toBeLessThan(50);
  expect(endToEnd).toBeLessThan(3000);
});

test("glass only on the auth card, dialogs and popovers; solid app surfaces; solid fallback; scroll cost under a dialog", async () => {
  const solid = [rail(), page.getByRole("navigation", { name: "Kênh" }), page.getByRole("main"), page.getByRole("complementary", { name: "Thành viên" }), scroller(), composer().locator("..")];
  for (const l of solid) await expectSolid(l);

  await page.getByRole("button", { name: /^Tuỳ chọn máy chủ/ }).click();
  const menu = page.locator("#guild-menu");
  await expect(menu).toBeVisible();
  await expectGlass(menu);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  await rail().getByRole("button", { name: "Tạo máy chủ" }).click();
  const dialog = page.getByRole("dialog", { name: "Tạo máy chủ" });
  await expect(dialog).toBeVisible();
  await expectGlass(dialog);
  for (const l of solid) await expectSolid(l); // nothing leaked onto the app behind it
  await expectNoHorizontalOverflow([dialog]);

  const frames = await sweepFrames();
  console.log(`scroll frames with a dialog open: ${JSON.stringify({ count: frames.length, p50: percentile(frames, 0.5).toFixed(1), p95: percentile(frames, 0.95).toFixed(1), max: percentile(frames, 1).toFixed(1) })}`);

  // reduced transparency: the same panel turns solid (if this Chromium can emulate the media feature)
  const cdp = (globalThis as { cdp?: { send: (m: string, p: object) => Promise<unknown> } }).cdp!;
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches), "Chromium cannot emulate prefers-reduced-transparency").toBe(true);
  await expectSolid(dialog);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "no-preference" }] });
  await expectGlass(dialog);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("layout stress: 40 channels, 60 members, 2000-char unbroken message, diacritics, min window", async () => {
  test.setTimeout(240_000);
  for (let i = 1; i <= 40; i++) await api(A.token, "POST", `/guilds/${guildId}/channels`, { name: `kenh-rat-dai-de-thu-cat-chu-${i}-${"x".repeat(40)}`, type: i % 7 ? "TEXT" : "VOICE" });
  const invite = await api<{ code: string }>(A.token, "POST", `/guilds/${guildId}/invites`, {});
  for (let i = 0; i < 60; i += 10) {
    await Promise.all(
      Array.from({ length: 10 }, async (_, j) => {
        const u = await register(`m${i + j}_rat_dai_ten`);
        await api(u.token, "POST", `/invites/${invite.code}/join`);
      }),
    );
  }
  await post(B, generalId, "x".repeat(2000));
  await post(B, generalId, "Thử dấu: Ạ Ặ Ậ Ẹ Ệ Ị Ọ Ộ Ợ Ụ Ự Ỵ ẳ ẵ ẩ ẫ ể ễ ỉ ĩ ỏ õ ổ ỗ ở ỡ ủ ũ ử ữ ỷ ỹ đường phố Hà Nội nghiêng ngả.");
  await rail().getByRole("button", { name: longName }).click();
  await channelList().getByRole("button", { name: /^general/ }).click(); // unread (B just posted): the name carries the badge text
  await expect(log().getByText("Thử dấu:", { exact: false })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Thành viên" }).getByRole("listitem")).toHaveCount(62);
  await expect(channelList().getByRole("listitem")).toHaveCount(44);
  const voice = channelList().getByRole("button", { name: /^Kênh thoại / }).first();
  await expect(voice).toBeEnabled(); // since 9d a voice channel can be joined

  const columns = () => [
    page.getByRole("navigation", { name: "Kênh" }),
    page.getByRole("main"),
    page.getByRole("complementary", { name: "Thành viên" }),
    scroller(),
    channelList().locator(".."),
  ];
  for (const [w, h] of [
    [1280, 800],
    [960, 600],
  ] as const) {
    await resize(w, h);
    await page.waitForTimeout(300);
    await expectNoHorizontalOverflow(columns());
    await expectEllipsis(channelList().getByRole("button", { name: /kenh-rat-dai-de-thu-cat-chu-1-/ }).first().locator("span").first());
    expect(await channelList().locator("..").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true); // scrolls, not clipped
  }
  await resize(1280, 800);
});

test("joining another server: bad code, disabled composer (no SEND), private channel appears after a grant, leave", async () => {
  const { guild } = await api<{ guild: { id: string } }>(C.token, "POST", "/guilds", { name: `Server của C ${run}` });
  const cGeneral = (await api<{ channels: { id: string }[] }>(C.token, "GET", `/guilds/${guild.id}`)).channels[0].id;
  await api(C.token, "PUT", `/channels/${cGeneral}/overwrites/${guild.id}`, { allow: 0, deny: 2 }); // @everyone: no SEND
  const secret = await api<{ id: string }>(C.token, "POST", `/guilds/${guild.id}/channels`, { name: "bi-mat", type: "TEXT" });
  await api(C.token, "PUT", `/channels/${secret.id}/overwrites/${guild.id}`, { allow: 0, deny: 1 }); // hidden from @everyone
  const invite = await api<{ code: string }>(C.token, "POST", `/guilds/${guild.id}/invites`, {});

  await rail().getByRole("button", { name: "Tham gia bằng mã mời" }).click();
  const dialog = page.getByRole("dialog", { name: "Tham gia máy chủ" });
  await dialog.getByLabel("Mã mời").fill("khongcoma");
  await dialog.getByRole("button", { name: "Tham gia" }).click();
  await expect(dialog.getByText("Mã mời không tồn tại hoặc đã hết hạn.")).toBeVisible();
  await dialog.getByLabel("Mã mời").fill(`https://loop.example/invite/${invite.code}`);
  await dialog.getByRole("button", { name: "Tham gia" }).click();
  await expect(dialog).toBeHidden();
  await expect(rail().getByRole("button", { name: `Server của C ${run}` })).toHaveAttribute("aria-current", "page");
  await expect(composer()).toBeDisabled();
  await expect(composer()).toHaveAttribute("placeholder", "Bạn không có quyền gửi tin nhắn trong kênh này.");
  await expect(channelList().getByRole("button", { name: "bi-mat", exact: true })).toHaveCount(0);
  // the owner of C's server is marked in the member list
  await expect(page.getByRole("complementary", { name: "Thành viên" }).getByText("Chủ máy chủ")).toHaveCount(1);

  const role = await api<{ id: string }>(C.token, "POST", `/guilds/${guild.id}/roles`, { name: "vip", permissions: 0 });
  await api(C.token, "PUT", `/channels/${secret.id}/overwrites/${role.id}`, { allow: 1, deny: 0 });
  await api(C.token, "PUT", `/guilds/${guild.id}/members/${A.user.id}/roles/${role.id}`);
  // the trigger: reopening the server refetches guild, roles and members (no server push for permission changes)
  await rail().getByRole("button", { name: `Server của C ${run}` }).click();
  await expect(channelList().getByRole("button", { name: "bi-mat", exact: true })).toBeVisible();
  await channelList().getByRole("button", { name: "bi-mat", exact: true }).click();
  await expect(composer()).toBeEnabled();

  await page.getByRole("button", { name: /^Tuỳ chọn máy chủ/ }).click();
  await page.getByRole("button", { name: "Rời máy chủ" }).click();
  const leave = page.getByRole("dialog", { name: /^Rời Server của C/ });
  await leave.getByRole("button", { name: "Rời máy chủ" }).click();
  await expect(leave).toBeHidden();
  await expect(rail().getByRole("button", { name: `Server của C ${run}` })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Bạn bè" })).toBeVisible();
});

test("the owner cannot leave: the 409 is explained", async () => {
  await rail().getByRole("button", { name: longName }).click();
  await page.getByRole("button", { name: /^Tuỳ chọn máy chủ/ }).click();
  await page.getByRole("button", { name: "Rời máy chủ" }).click();
  const leave = page.getByRole("dialog", { name: /^Rời / });
  await leave.getByRole("button", { name: "Rời máy chủ" }).click();
  await expect(leave.getByText("Bạn là chủ máy chủ nên chưa thể rời đi.", { exact: false })).toBeVisible();
  await leave.getByRole("button", { name: "Huỷ" }).click();
  friend.socket.disconnect();
});

test("the socket upgraded to a websocket on the API origin; sign-out stops it", async () => {
  expect(wsUrls.some((u) => u.startsWith("ws://localhost:3000/socket.io/") && u.includes("transport=websocket"))).toBe(true);
  await page.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(page.getByRole("heading", { name: "Chào mừng trở lại" })).toBeVisible();
  // B posts after A signed out: nothing may be processed (and the login screen shows no chat)
  await post(B, generalId, "Sau khi A đăng xuất");
  await page.waitForTimeout(500);
  await expect(page.getByText("Sau khi A đăng xuất")).toHaveCount(0);
});
