import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { api, expectEllipsis, expectNoHorizontalOverflow, launchAs, launchOptions, password, register, resize, run, type Session } from "./helpers";

// Redesign R3 (server rail, channel column, chat, member column), checked through the DOM, computed styles and timings
// (no pictures). Real dev server + docker; everyone but the app user is an API script.
let app: ElectronApplication;
let page: Page;
let A: Session; // the person using the app, owner of everything
let B: Session; // writes the messages
const userData = mkdtempSync(join(tmpdir(), "loop-e2e-r3-"));
const consoleErrors: string[] = [];

const ALPHA = `Alpha Đà Nẵng ${run} `.padEnd(90, "ấ");
const BETA = `Beta ${run}`;
const rail = () => page.getByRole("navigation", { name: "Danh sách máy chủ" });
const railButton = (name: string | RegExp) => rail().getByRole("button", { name });
const channelList = () => page.getByRole("list", { name: "Danh sách kênh" });
const channelButton = (name: RegExp) => channelList().getByRole("button", { name });
const log = () => page.getByRole("log");
const scroller = () => log().locator("..");
const members = () => page.getByRole("complementary", { name: "Thành viên" });
const pill = () => page.locator("[data-rail-pill]");
const post = (s: Session, channelId: string, content: string) => api<{ id: string }>(s.token, "POST", `/channels/${channelId}/messages`, { content });
const reduceMotion = async (on: boolean) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "no-preference" }] });
};
const centreY = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
const arrived = () => log().locator("[data-arrived]");

let alpha: { id: string; general: string };
let beta: { id: string };
let scrollChannel = "";
let railGuilds: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  [A, B] = await Promise.all([register("r3a"), register("r3b")]);
  const make = async (name: string) => api<{ guild: { id: string }; channels: { id: string; name: string }[] }>(A.token, "POST", "/guilds", { name });
  const a = await make(ALPHA);
  alpha = { id: a.guild.id, general: a.channels[0].id };
  beta = { id: (await make(BETA)).guild.id };
  railGuilds = (await Promise.all(Array.from({ length: 20 }, (_, i) => make(`Rail ${String(i + 1).padStart(2, "0")} ${run}`)))).map((g) => g.guild.id);
  const invite = await api<{ code: string }>(A.token, "POST", `/guilds/${alpha.id}/invites`, {});
  await api(B.token, "POST", `/invites/${invite.code}/join`);
  scrollChannel = (await api<{ id: string }>(A.token, "POST", `/guilds/${alpha.id}/channels`, { name: "cuon", type: "TEXT" })).id;
  for (let i = 0; i < 130; i += 10) await Promise.all(Array.from({ length: 10 }, (_, j) => post(B, scrollChannel, `Tin cuộn ${i + j + 1}`)));
  await post(A, scrollChannel, "Tin của chính mình");
  ({ app, page } = await launchAs(A, { userData }));
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
});

test.afterAll(async () => void (await app?.close().catch(() => undefined)));

test("rail: the pill springs to the active server, is at the end state at once under reduced motion, survives a scrolled list and the keyboard", async () => {
  await railButton(/^Alpha/).click();
  await expect.poll(async () => Math.abs((await centreY(pill())) - (await centreY(railButton(/^Alpha/))))).toBeLessThan(1.5);

  // samples of the pill's translateY on every frame while switching
  const switchTo = async (name: string | RegExp) => {
    const samples = page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const el = document.querySelector("[data-rail-pill]")!;
          const out: number[] = [];
          const t0 = performance.now();
          const tick = () => {
            out.push(new DOMMatrix(getComputedStyle(el).transform).m42);
            if (performance.now() - t0 < 700) requestAnimationFrame(tick);
            else resolve(out);
          };
          requestAnimationFrame(tick);
        }),
    );
    await railButton(name).click();
    return samples;
  };
  const moving = await switchTo(BETA);
  const start = moving[0];
  const end = moving.at(-1)!;
  expect(end).not.toBe(start);
  const between = moving.filter((y) => y > Math.min(start, end) + 0.5 && y < Math.max(start, end) - 0.5);
  expect(between.length, "a spring travels through intermediate positions").toBeGreaterThanOrEqual(2);
  expect(Math.abs((await centreY(pill())) - (await centreY(railButton(BETA))))).toBeLessThan(1.5);

  await reduceMotion(true);
  const instant = await switchTo(/^Alpha/);
  expect(instant.filter((y) => y !== instant[0] && y !== instant.at(-1)), "reduced motion jumps").toEqual([]);
  expect(Math.abs((await centreY(pill())) - (await centreY(railButton(/^Alpha/))))).toBeLessThan(1.5);
  await reduceMotion(false);

  // 20 more servers: the list scrolls, the pill is a child of the scrolled content and keeps up
  const list = pill().locator("..");
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const guildButtons = rail().locator("button[data-nav-item]"); // the last two buttons are Tạo / Tham gia
  const last = guildButtons.nth((await guildButtons.count()) - 3); // the lowest server in the list (their order is the server's)
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect.poll(async () => Math.abs((await centreY(pill())) - (await centreY(last)))).toBeLessThan(1.5);
  await list.evaluate((el) => (el.scrollTop = 0)); // scrolled away: still glued to its item (it moved with the content)
  const scrolledAway = await pill().evaluate((el) => el.getBoundingClientRect().top);
  expect(scrolledAway).toBeGreaterThan(await page.evaluate(() => innerHeight)); // below the visible part, with its item

  // keyboard: arrows move focus, Enter opens, the pill follows (the last two buttons are Tạo / Tham gia)
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const items = rail().locator("button[data-nav-item]");
  const n = await items.count();
  await items.nth(n - 3).focus();
  await page.keyboard.press("ArrowUp");
  const previous = items.nth(n - 4);
  await expect(previous).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(previous).toHaveAttribute("aria-current", "page");
  await expect.poll(async () => Math.abs((await centreY(pill())) - (await centreY(previous)))).toBeLessThan(1.5);
});

test("tooltips: after the delay with aria-describedby, on the right of rail buttons, Escape / leave / blur hide them; no native title= left; Send shows Enter", async () => {
  await railButton(/^Alpha/).click();
  await expect(channelButton(/^cuon/)).toBeVisible();
  const button = railButton(/^Alpha/);
  await page.mouse.move(600, 400);
  await button.hover();
  await page.waitForTimeout(150);
  await expect(page.getByRole("tooltip")).toHaveCount(0); // not before the delay
  const tip = page.getByRole("tooltip");
  await expect(tip).toHaveText(ALPHA, { timeout: 2000 });
  const id = await tip.getAttribute("id");
  await expect(button).toHaveAttribute("aria-describedby", id!);
  // the tooltip springs in (scale), so poll for its settled position instead of measuring mid-animation
  await expect
    .poll(async () => {
      const [t, b] = await Promise.all([tip.boundingBox(), button.boundingBox()]);
      return t!.x >= b!.x + b!.width - 1 && Math.abs(t!.y + t!.height / 2 - (b!.y + b!.height / 2)) < 6; // right of the button, vertically centred
    })
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  await expect(button).not.toHaveAttribute("aria-describedby", /./);
  await page.mouse.move(600, 400);
  await button.hover();
  await expect(tip).toBeVisible({ timeout: 2000 }); // Escape's dismissal ended with the pointer leaving
  await page.mouse.move(600, 400);
  await expect(tip).toHaveCount(0);

  // keyboard focus shows it sooner (300 ms) and blur hides it
  await page.keyboard.press("Shift");
  await railButton(BETA).focus();
  await expect(page.getByRole("tooltip")).toHaveText(BETA, { timeout: 1500 });
  await railButton(/^Alpha/).focus();
  await expect(page.getByRole("tooltip")).toHaveCount(0, { timeout: 100 });

  // Send: its tooltip carries the real shortcut
  await channelButton(/^cuon/).click();
  const composer = page.getByRole("textbox", { name: /^Nhắn vào #/ });
  await composer.fill("xin chào");
  await page.getByRole("button", { name: "Gửi", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText("Gửi", { timeout: 2000 });
  await expect(page.getByRole("tooltip").locator("kbd")).toHaveText("Enter");
  await composer.fill("");
  await page.mouse.move(600, 300);

  // every migrated chrome button keeps an accessible name and none keeps a native title
  expect(await page.locator("button[title], [role=button][title], a[title]").count()).toBe(0);
  for (const name of ["Tạo máy chủ", "Tham gia bằng mã mời", "Đính kèm tệp", "Menu tài khoản"]) await expect(page.getByRole("button", { name: new RegExp(name) }).first()).toBeVisible();
});

test("chat rows: sticky day separator, toolbar buttons >= 40x40 in order Sửa/Sao chép/Xóa, Sao chép puts the exact text on the clipboard and morphs for ~1.5 s", async () => {
  await channelButton(/^cuon/).click();
  await expect(log().getByRole("article").last()).toContainText("Tin của chính mình");

  // sticky: computed position, and it stays glued to the top of the list while its messages scroll under it
  const sep = log().getByRole("separator").first();
  expect(await sep.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
  await scroller().evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
  await expect.poll(async () => Math.abs((await sep.boundingBox())!.y - (await scroller().boundingBox())!.y)).toBeLessThan(2);
  await scroller().evaluate((el) => (el.scrollTop = el.scrollHeight));

  // toolbar on someone else's message: Sao chép, Xóa (A owns the server); on A's own: Sửa first
  const theirs = log().getByRole("article").filter({ hasText: /^.*Tin cuộn/ }).last();
  await theirs.hover();
  const bar = theirs.getByRole("toolbar", { name: "Thao tác với tin nhắn" });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button")).toHaveText(["", "", "", "", "", ""]);
  expect(await bar.getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual(["Thêm biểu cảm", "Trả lời", "Tạo luồng", "Ghim tin nhắn", "Sao chép nội dung", "Xoá tin nhắn"]);
  const mine = log().getByRole("article").filter({ hasText: "Tin của chính mình" });
  await mine.hover();
  const myBar = mine.getByRole("toolbar");
  expect(await myBar.getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual(["Thêm biểu cảm", "Trả lời", "Tạo luồng", "Ghim tin nhắn", "Sửa tin nhắn", "Sao chép nội dung", "Xoá tin nhắn"]);
  for (const button of await myBar.getByRole("button").all()) {
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(40);
    expect(box.height).toBeGreaterThanOrEqual(40);
  }

  // copy: exact text (a quote and a line break included), the label morphs, the live region says it, then back to idle
  const text = 'Sao chép "đúng" nội dung\nhai dòng ạ';
  const sent = await post(B, scrollChannel, text);
  const row = log().locator(`[data-mid="${sent.id}"]`);
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByRole("button", { name: "Sao chép nội dung" }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(text);
  const copied = row.getByRole("button", { name: "Đã sao chép" });
  await expect(copied).toBeVisible();
  await expect(row.getByRole("toolbar").locator("[aria-live=polite]")).toHaveText("Đã sao chép");
  await page.waitForTimeout(900);
  await expect(copied).toBeVisible(); // still "copied" before 1.5 s
  await expect(row.getByRole("button", { name: "Sao chép nội dung" })).toBeVisible({ timeout: 2000 });
  await expect(row.getByRole("toolbar").locator("[aria-live=polite]")).toHaveText("");
});

test("arrival animation: only a live message while pinned; never history, catch-up, scrolled-up or reduced motion; the row ends clean", async () => {
  // keep every WebSocket the app opens, so a dropped connection can be forced (a real reconnect + catch-up)
  await page.addInitScript(() => {
    const w = window as unknown as { __ws: WebSocket[]; WebSocket: typeof WebSocket };
    w.__ws = [];
    const Orig = w.WebSocket;
    w.WebSocket = class extends Orig {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        w.__ws.push(this);
      }
    };
  });
  await page.reload();
  await expect(log().getByRole("article").last()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500); // the subscription and its first catch-up settle before a message can be "live"
  await scroller().evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(arrived()).toHaveCount(0); // the initial render and the first page did not animate
  expect(await log().getByRole("article").first().getAttribute("data-arrived")).toBeNull();

  const live1 = await post(B, scrollChannel, "Tin trực tiếp 1");
  const row1 = log().locator(`[data-mid="${live1.id}"]`);
  await expect(row1).toHaveAttribute("data-arrived", "live");
  await expect(arrived()).toHaveCount(1);
  await expect.poll(() => row1.evaluate((el) => el.style.opacity + el.style.transform), { timeout: 2000 }).toBe(""); // inline styles cleaned
  expect(await log().locator("[data-mid]").evaluateAll((els) => els.filter((e) => (e as HTMLElement).style.opacity !== "").length)).toBe(0);

  // paging up: older rows mount, none animates
  await scroller().evaluate((el) => (el.scrollTop = 0));
  await expect(log().getByRole("article")).toHaveCount(101, { timeout: 5000 });
  await expect(arrived()).toHaveCount(1);

  // scrolled up: a live message does not animate (and gives the pill)
  const live2 = await post(B, scrollChannel, "Tin trực tiếp 2 khi đang đọc tin cũ");
  await expect(page.getByRole("button", { name: /tin nhắn mới/ })).toBeVisible();
  await expect(log().locator(`[data-mid="${live2.id}"]`)).toHaveCount(1);
  expect(await log().locator(`[data-mid="${live2.id}"]`).getAttribute("data-arrived")).toBeNull();
  await page.getByRole("button", { name: /tin nhắn mới/ }).click();

  // a dropped socket: three messages posted meanwhile come back through the catch-up, none animates
  await page.evaluate(() => (window as unknown as { __ws: WebSocket[] }).__ws.forEach((w) => w.close()));
  const missed = [await post(B, scrollChannel, "Bỏ lỡ 1"), await post(B, scrollChannel, "Bỏ lỡ 2"), await post(B, scrollChannel, "Bỏ lỡ 3")];
  for (const m of missed) await expect(log().locator(`[data-mid="${m.id}"]`)).toHaveCount(1, { timeout: 20_000 });
  await scroller().evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(arrived()).toHaveCount(1);

  // reduced motion: a live message while pinned does not animate
  await reduceMotion(true);
  await scroller().evaluate((el) => (el.scrollTop = el.scrollHeight));
  const live3 = await post(B, scrollChannel, "Tin trực tiếp 3 giảm chuyển động");
  await expect(log().locator(`[data-mid="${live3.id}"]`)).toHaveCount(1);
  await expect(arrived()).toHaveCount(1);
  await reduceMotion(false);

  // and back to normal: pinned + full motion animates again, on that one row only
  await scroller().evaluate((el) => (el.scrollTop = el.scrollHeight));
  const live4 = await post(B, scrollChannel, "Tin trực tiếp 4");
  await expect(log().locator(`[data-mid="${live4.id}"]`)).toHaveAttribute("data-arrived", "live");
  await expect(arrived()).toHaveCount(2);
});

test("switching channel: one fade + slide of the main area only; skipped under reduced motion; the list stays pinned", async () => {
  const sampleMain = () =>
    page.evaluate(
      () =>
        new Promise<{ min: number; moved: boolean; rows: boolean }>((resolve) => {
          const main = document.querySelector("main")!;
          let min = 1;
          let moved = false;
          let rows = false;
          const t0 = performance.now();
          const tick = () => {
            const cs = getComputedStyle(main);
            min = Math.min(min, +cs.opacity);
            moved ||= cs.transform !== "none" && new DOMMatrix(cs.transform).m41 !== 0;
            rows ||= [...document.querySelectorAll<HTMLElement>("[data-mid]")].some((el) => el.style.opacity !== "");
            if (performance.now() - t0 < 500) requestAnimationFrame(tick);
            else resolve({ min, moved, rows });
          };
          requestAnimationFrame(tick);
        }),
    );
  await page.waitForTimeout(500); // the previous test's last arrival animation has ended
  const general = channelButton(/^general/);
  const sampled = sampleMain();
  await general.click();
  const s = await sampled;
  expect(s.min).toBeLessThan(0.9);
  expect(s.moved).toBe(true);
  expect(s.rows, "rows never animate on a channel switch").toBe(false);
  expect(await page.locator("main").evaluate((el) => el.style.opacity + el.style.transform)).toBe(""); // ended clean
  // typing works at once, no wait for the transition
  await page.getByRole("textbox", { name: /^Nhắn vào #general/ }).fill("gõ ngay");
  await page.getByRole("textbox", { name: /^Nhắn vào #general/ }).fill("");

  await reduceMotion(true);
  const sampledReduced = sampleMain();
  await channelButton(/^cuon/).click();
  const r = await sampledReduced;
  expect(r.min).toBe(1);
  expect(r.moved).toBe(false);
  await reduceMotion(false);

  // pinned to the bottom right after the switch (not delayed by the transition)
  await channelButton(/^general/).click();
  await channelButton(/^cuon/).click();
  await expect(log().getByRole("article").last()).toBeInViewport();
  const gap = await scroller().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  expect(gap).toBeLessThan(4);
});

test("member column: presence groups (online by role / online / one offline group), no @everyone, 60 members with long names", async () => {
  test.setTimeout(240_000);
  const invite = await api<{ code: string }>(A.token, "POST", `/guilds/${alpha.id}/invites`, {});
  const people: Session[] = [];
  for (let i = 0; i < 58; i += 10)
    people.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(10, 58 - i) }, async (_, j) => {
          const u = await register(`r3m${i + j}_rat_dai_ten_de_cat`);
          await api(u.token, "POST", `/invites/${invite.code}/join`);
          return u;
        }),
      )),
    );
  const mod = await api<{ id: string; position: number }>(A.token, "POST", `/guilds/${alpha.id}/roles`, { name: "Điều hành", permissions: 2 });
  const vip = await api<{ id: string; position: number }>(A.token, "POST", `/guilds/${alpha.id}/roles`, { name: "VIP", permissions: 2 });
  const give = (u: Session, roleId: string) => api(A.token, "PUT", `/guilds/${alpha.id}/members/${u.user.id}/roles/${roleId}`);
  await give(people[0], vip.id);
  await give(people[1], vip.id);
  await give(people[2], mod.id);
  await give(people[3], mod.id);
  await give(people[3], vip.id); // both: sits under the higher one only
  await give(B, vip.id);

  await railButton(BETA).click();
  await railButton(/^Alpha/).click();
  await channelButton(/^cuon/).click();
  // presence-based groups: only A (and maybe B) hold a socket here, the scripted people are offline and merged into one group
  const headings = members().getByRole("heading", { level: 2 });
  await expect(headings.last()).toContainText("Ngoại tuyến", { timeout: 10_000 });
  await expect(headings.filter({ hasText: "everyone" })).toHaveCount(0);
  await expect(headings.filter({ hasText: "Chủ máy chủ" })).toHaveCount(0);
  const counts = (await headings.locator("span.numeric").allTextContents()).map((c) => Number(c.replace("— ", "")));
  expect(counts.reduce((a, b) => a + b, 0)).toBe(60);
  expect(counts.at(-1)).toBeGreaterThanOrEqual(58); // the 58 scripted people never connect; B may or may not
  await expect(members().getByRole("listitem")).toHaveCount(60);

  // long names: ellipsis, no overflow, in both window sizes
  const long = members().getByRole("listitem").filter({ hasText: "r3m5_rat_dai" }).first().locator("span.truncate");
  await expectEllipsis(long);
  for (const [w, h] of [
    [1280, 800],
    [960, 600],
  ] as const) {
    await resize(app, w, h);
    await page.waitForTimeout(300);
    await expectNoHorizontalOverflow([page.getByRole("navigation", { name: "Kênh" }), page.getByRole("main"), members(), scroller(), members().locator("div").first()]);
    await expectEllipsis(long);
    await expectEllipsis(page.getByRole("button", { name: /^Tuỳ chọn máy chủ/ }).locator("span.truncate"));
  }
  await resize(app, 1280, 800);
});

test("glass stays on dialogs, popovers and tooltips only (the app columns are solid)", async () => {
  const blur = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backdropFilter);
  for (const l of [rail(), page.getByRole("navigation", { name: "Kênh" }), page.getByRole("main"), members(), scroller()]) expect(await blur(l)).toBe("none");
  await log().getByRole("article").last().hover();
  expect(await blur(log().getByRole("article").last().getByRole("toolbar"))).toBe("none"); // the toolbar is raise + shadow, not glass
  await page.mouse.move(600, 400);
  await railButton(/^Alpha/).hover();
  await expect(page.getByRole("tooltip")).toBeVisible({ timeout: 2000 });
  expect(await blur(page.getByRole("tooltip"))).toMatch(/^blur/);
});

test("density: Gọn is a switch in Giao diện, applies at once, persists across a relaunch, and belongs to the account", async () => {
  const html = () => page.locator("html");
  const avatar = () => log().getByRole("article").filter({ hasText: "Tin cuộn" }).first().locator("[aria-hidden]").first();
  await expect(html()).toHaveAttribute("data-density", "comfy");
  expect((await avatar().boundingBox())!.width).toBe(40);
  await page.getByRole("button", { name: "Cài đặt của bạn" }).click();
  const group = page.getByRole("group", { name: "Mật độ tin nhắn" });
  await expect(group.getByRole("radio", { name: "Thoải mái" })).toBeChecked();
  await group.getByRole("radio", { name: "Gọn" }).locator("..").click();
  await expect(group.getByRole("radio", { name: "Gọn" })).toBeChecked();
  await expect(html()).toHaveAttribute("data-density", "compact");
  expect(await page.evaluate((id) => localStorage.getItem(`loop.density.${id}`), A.user.id)).toBe("compact");
  await page.keyboard.press("Escape");
  await channelButton(/^cuon/).click();
  await expect(log().getByRole("article").last()).toBeVisible();
  expect(Math.round((await avatar().boundingBox())!.width)).toBe(32);
  expect(await log().getByRole("article").filter({ hasText: "Tin cuộn" }).last().locator("p", { hasText: "Tin cuộn" }).last().evaluate((el) => getComputedStyle(el).fontSize)).toBe("14px");

  // relaunch on the same profile: still compact
  await app.close();
  app = await _electron.launch(launchOptions(userData)); // the session is restored from the profile
  page = await app.firstWindow();
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  await expect(rail()).toBeVisible({ timeout: 15_000 });
  await expect(html()).toHaveAttribute("data-density", "compact");

  // another account on the same profile starts at the default; the first keeps its own
  const logout = async () => {
    await page.getByRole("button", { name: "Menu tài khoản" }).click();
    await page.getByRole("button", { name: "Đăng xuất" }).first().click();
  };
  await logout();
  await page.getByLabel("Email").fill(`${B.user.username}@example.com`);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Bạn bè" })).toBeVisible();
  await expect(html()).toHaveAttribute("data-density", "comfy");
  await logout();
  await page.getByLabel("Email").fill(`${A.user.username}@example.com`);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
  await page.keyboard.press("Enter");
  await expect(rail()).toBeVisible();
  await expect(html()).toHaveAttribute("data-density", "compact");
});

test("no console errors", () => {
  expect(consoleErrors).toEqual([]);
});
