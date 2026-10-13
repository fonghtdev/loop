import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { api, befriend, expectNoHorizontalOverflow, launchAs, launchOptions, password, register, resize, run, type Session } from "./helpers";

// Redesign R5 (the quick switcher, Ctrl/Cmd+K), checked through the DOM, computed styles and behaviour (no pictures).
// Real dev server + docker; everyone but the app user is an API script.
const FAKE = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
let app: ElectronApplication;
let page: Page;
let A: Session;
let B: Session; // friend with a DM
let C: Session; // friend without a DM
let L: Session; // friend with a very long name
let g1: { id: string; name: string };
let g2: { id: string; name: string };
const userData = mkdtempSync(join(tmpdir(), "loop-e2e-r5-"));
const consoleErrors: string[] = [];

const dialog = () => page.getByRole("dialog", { name: "Chuyển nhanh" });
const box = () => dialog().getByRole("combobox");
const options = () => dialog().getByRole("option");
const option = (text: string) => options().filter({ hasText: text });
const group = (name: string) => dialog().getByRole("group", { name });
const rail = () => page.getByRole("navigation", { name: "Danh sách máy chủ" });
const composer = (channel: string) => page.getByRole("textbox", { name: `Nhắn vào #${channel}` });
const bar = () => page.getByRole("region", { name: "Đang trong cuộc gọi" });
const openPalette = async (key = "Control+k") => {
  await expect(dialog()).toBeHidden(); // the previous Esc may still be closing it
  await page.keyboard.press(key);
  await expect(dialog()).toBeVisible();
  await expect(box()).toBeFocused();
};
const choose = async (query: string, target: string) => {
  await openPalette();
  await box().fill(query);
  await expect(option(target).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog()).toBeHidden();
};
const createGuild = async (name: string) => {
  const r = await api<{ guild: { id: string }; channels: { id: string }[] }>(A.token, "POST", "/guilds", { name });
  return { id: r.guild.id, name, general: r.channels[0].id };
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  [A, B, C, L] = await Promise.all([register("r5a"), register("r5b"), register("r5c"), register("r5dai" + "y".repeat(18))]);
  await Promise.all([befriend(A, B), befriend(A, C), befriend(A, L)]);
  await api(A.token, "POST", "/dms", { userId: B.user.id });
  g1 = await createGuild(`Chúng ta ${run}`);
  g2 = await createGuild(`Khác ${run}`);
  const { categories } = await api<{ categories: { id: string; name: string }[] }>(A.token, "GET", `/guilds/${g1.id}`);
  await api(A.token, "POST", `/guilds/${g1.id}/channels`, { name: "chung", type: "TEXT", categoryId: categories.find((c) => c.name === "Kênh văn bản")!.id });
  await api(A.token, "POST", `/guilds/${g2.id}/channels`, { name: "phong-hai", type: "TEXT" });
  await api(A.token, "POST", `/guilds/${g2.id}/channels`, { name: "voz-r5", type: "VOICE" });
  await createGuild(`Đà Nẵng ${run}`);
  await createGuild(`<b>hi</b> ${run}`);
  const long = await createGuild(`Máy-chủ-có-tên-rất-dài-${run}`);
  await api(A.token, "POST", `/guilds/${long.id}/channels`, { name: "kenh-dai-" + "d".repeat(31), type: "TEXT" });
  ({ app, page } = await launchAs(A, { userData, args: FAKE }));
  await resize(app, 1280, 800);
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
});
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
});

test("Ctrl+K opens, Esc closes and gives the focus back; Cmd+K works too; the button opens it", async () => {
  const opener = page.getByRole("button", { name: "Cài đặt của bạn" });
  await opener.focus();
  await openPalette();
  await page.keyboard.press("Escape");
  await expect(dialog()).toBeHidden();
  await expect(opener).toBeFocused();
  await openPalette("Meta+k");
  await page.keyboard.press("Meta+k");
  await expect(dialog()).toBeHidden();
  const button = page.getByRole("button", { name: "Chuyển nhanh" });
  await expect(button).toHaveAttribute("aria-keyshortcuts", "Control+K Meta+K");
  await button.click();
  await expect(dialog()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
  await button.hover();
  await expect(page.getByRole("tooltip")).toContainText(/^Chuyển nhanh(⌘K|Ctrl K)$/);
});

test("the server column has the quick-switch field and the category headers, with + for those who may create channels", async () => {
  await rail().getByRole("button", { name: g1.name }).click();
  const field = page.getByRole("button", { name: "Chuyển nhanh" });
  await expect(field).toContainText(/^Chuyển nhanh(⌘K|Ctrl K)$/);
  await field.click();
  await expect(dialog()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog()).toBeHidden();
  const list = page.getByRole("list", { name: "Danh sách kênh" });
  await expect(list.getByText("Kênh văn bản")).toBeVisible();
  await expect(list.getByText("Kênh thoại")).toBeVisible();
  await list.getByRole("button", { name: "Tạo kênh trong Kênh thoại" }).click(); // the category's +: the dialog knows where the channel goes
  await expect(page.getByRole("dialog", { name: "Tạo kênh" }).getByText("Trong danh mục Kênh thoại")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  // a plain member sees the headers but no +
  const { code } = await api<{ code: string }>(A.token, "POST", `/guilds/${g1.id}/invites`, {});
  await api(B.token, "POST", `/invites/${code}/join`);
  const member = await launchAs(B);
  const memberList = member.page.getByRole("list", { name: "Danh sách kênh" });
  await member.page.getByRole("navigation", { name: "Danh sách máy chủ" }).getByRole("button", { name: g1.name }).click();
  await expect(memberList.getByText("Kênh văn bản")).toBeVisible();
  await expect(memberList.getByRole("button", { name: /^Tạo kênh/ })).toHaveCount(0);
  await member.app.close();
});

test("the shortcut works while the composer has the focus, and not while another dialog is open", async () => {
  await rail().getByRole("button", { name: g1.name }).click();
  await expect(composer("general")).toBeVisible();
  await composer("general").focus();
  await composer("general").fill("draft stays");
  await openPalette();
  await page.keyboard.press("Control+k");
  await expect(dialog()).toBeHidden();
  await expect(composer("general")).toBeFocused();
  await expect(composer("general")).toHaveValue("draft stays");
  // another dialog (create server) is open: the shortcut is ignored
  await rail().getByRole("button", { name: "Tạo máy chủ" }).click();
  const other = page.getByRole("dialog").filter({ visible: true });
  await expect(other).toHaveCount(1);
  await page.keyboard.press("Control+k");
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await expect(dialog()).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("the shortcut does nothing on the sign-in screen", async () => {
  const second = await _electron.launch(launchOptions(mkdtempSync(join(tmpdir(), "loop-e2e-r5-auth-")), []));
  const p = await second.firstWindow();
  await expect(p.getByLabel("Email")).toBeVisible();
  await p.keyboard.press("Control+k");
  await p.keyboard.press("Meta+k");
  await p.waitForTimeout(300);
  expect(await p.locator("dialog").count()).toBe(0);
  await second.close();
});

test("typing without diacritics finds channels and servers with diacritics (and đ) and the other way round", async () => {
  await openPalette();
  await box().fill("chung");
  await expect(group("Kênh").getByRole("option", { name: /chung/ })).toBeVisible();
  await expect(group("Máy chủ").getByRole("option", { name: new RegExp(`Chúng ta ${run}`) })).toBeVisible();
  await box().fill("chúng");
  await expect(group("Kênh").getByRole("option", { name: /chung/ })).toBeVisible();
  await box().fill("da nang");
  await expect(group("Máy chủ").getByRole("option", { name: new RegExp(`Đà Nẵng ${run}`) })).toBeVisible();
  await box().fill("đà nẵng");
  await expect(option(`Đà Nẵng ${run}`).first()).toBeVisible();
  await page.keyboard.press("Escape");
});

test("combobox and listbox semantics: activedescendant follows the active row, groups are labelled, the count is announced", async () => {
  await openPalette();
  await box().fill(run);
  await expect(options().nth(5)).toBeVisible();
  const state = () =>
    page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("dialog[open] [role=combobox]")!;
      const list = document.getElementById(input.getAttribute("aria-controls")!);
      const active = document.getElementById(input.getAttribute("aria-activedescendant") ?? "");
      const selected = [...document.querySelectorAll("dialog[open] [role=option][aria-selected=true]")];
      const groups = [...document.querySelectorAll("dialog[open] [role=group]")].map((g) => document.getElementById(g.getAttribute("aria-labelledby")!)?.textContent);
      return { expanded: input.getAttribute("aria-expanded"), listbox: list?.getAttribute("role"), activeIsSelected: !!active && selected.length === 1 && selected[0] === active, index: [...document.querySelectorAll("dialog[open] [role=option]")].indexOf(active!), groups };
    });
  const s0 = await state();
  expect(s0).toMatchObject({ expanded: "true", listbox: "listbox", activeIsSelected: true, index: 0 });
  expect(s0.groups).toEqual(expect.arrayContaining(["Máy chủ", "Kênh"]));
  await page.keyboard.press("ArrowDown");
  expect((await state()).index).toBe(1);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp"); // wraps to the last row
  const total = await options().count();
  expect((await state()).index).toBe(total - 1);
  await page.keyboard.press("Home");
  expect((await state()).index).toBe(0);
  await page.keyboard.press("End");
  expect((await state()).index).toBe(total - 1);
  await page.keyboard.press("Home");
  await page.keyboard.press("PageDown");
  expect((await state()).index).toBe(Math.min(8, total - 1));
  await page.keyboard.press("Home");
  await expect(dialog().getByRole("status")).toHaveText(/^\d+ kết quả$/);
  // the pointer moves the selection; the keyboard then moves on from there and the stationary pointer does not take it back
  const row = await options().nth(3).boundingBox();
  await page.mouse.move(row!.x + 40, row!.y + 8);
  await page.mouse.move(row!.x + 60, row!.y + 12);
  expect((await state()).index).toBe(3);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  expect((await state()).index).toBe(5);
  await page.keyboard.press("Escape");
});

test("the matched letters are plain text: markup in a name never becomes markup", async () => {
  await openPalette();
  await box().fill("hi");
  const row = option(`<b>hi</b> ${run}`).first(); // the server; its channels follow
  await expect(row).toBeVisible();
  expect(await row.locator("b").count()).toBe(0);
  const marks = row.locator("[data-match]");
  expect(await marks.count()).toBeGreaterThan(0);
  expect(await marks.evaluateAll((els) => els.every((e) => e.children.length === 0))).toBe(true);
  expect(await row.locator("[data-match]").allTextContents()).toEqual(expect.arrayContaining(["hi"]));
  expect(await row.evaluate((el) => el.querySelectorAll("*:not(span):not(kbd):not(svg):not(path)").length)).toBe(0);
  await page.keyboard.press("Escape");
});

test("glass on the palette, none on the solid app surfaces", async () => {
  await openPalette();
  const glass = await dialog().evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(glass).toContain("blur");
  for (const surface of [rail(), page.getByRole("navigation", { name: "Kênh" }), page.locator("main")])
    expect(await surface.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none");
  await page.keyboard.press("Escape");
});

test("no results: the empty state with its illustration, combobox collapsed, announced", async () => {
  await openPalette();
  await box().fill("zzqqxx");
  await expect(dialog().getByText("Không tìm thấy kết quả cho ‘zzqqxx’")).toBeVisible();
  await expect(dialog().locator("svg[aria-hidden=true]").first()).toBeVisible();
  await expect(options()).toHaveCount(0);
  await expect(box()).toHaveAttribute("aria-expanded", "false");
  await expect(dialog().getByRole("status")).toHaveText("Không có kết quả");
  await page.keyboard.press("Enter"); // nothing to open: the palette stays
  await expect(dialog()).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a channel of ANOTHER server: the main area shows it and the rail follows", async () => {
  await rail().getByRole("button", { name: g1.name }).click();
  await choose("phong-hai", "phong-hai");
  await expect(composer("phong-hai")).toBeVisible();
  await expect(rail().getByRole("button", { name: g2.name })).toHaveAttribute("aria-current", "page");
});

test("a DM, and a friend without a DM (the DM is created)", async () => {
  await choose(B.user.username, B.user.username);
  await expect(page.getByRole("heading", { name: B.user.username })).toBeVisible();
  await openPalette();
  await box().fill(C.user.username);
  await expect(group("Bạn bè").getByRole("option", { name: new RegExp(C.user.username) })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: C.user.username })).toBeVisible();
  const dms = await api<{ user: { id: string } }[]>(A.token, "GET", "/dms");
  expect(dms.some((d) => d.user.id === C.user.id)).toBe(true);
});

test("a voice channel is joined without leaving the view, and opens its room once connected - exactly as a click in the channel list does", async () => {
  const inVoice = async () => {
    await expect(bar().getByText("Đã kết nối giọng nói", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /voz-r5/ })).toHaveCount(0); // joined, the view did not move
    await expect(page.getByRole("complementary", { name: "Thành viên" })).toHaveCount(1);
  };
  const inRoom = async () => {
    await expect(page.getByRole("heading", { name: /voz-r5/ })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Thành viên" })).toHaveCount(0);
  };
  const leave = async () => {
    await bar().getByRole("button", { name: "Rời kênh thoại" }).click();
    await expect(bar()).toBeHidden();
  };
  await choose("voz-r5", "voz-r5");
  await inVoice();
  await choose("voz-r5", "voz-r5"); // connected: the same choice opens the room
  await inRoom();
  await leave();
  await page.getByRole("button", { name: "Trang chủ" }).click();
  await rail().getByRole("button", { name: g2.name }).click();
  await page.getByRole("button", { name: "Kênh thoại voz-r5", exact: true }).click();
  await inVoice();
  await page.getByRole("button", { name: "Kênh thoại voz-r5", exact: true }).click();
  await inRoom();
  await leave();
});

test("no horizontal overflow, rows >= 40 px, the dialog inside the window - at 1280x800 and 960x600 with 40-character names", async () => {
  for (const [w, h] of [[1280, 800], [960, 600]]) {
    await resize(app, w, h);
    await openPalette();
    await box().fill("dai");
    await expect(option("kenh-dai-").first()).toBeVisible();
    await expect(option(L.user.username).first()).toBeVisible();
    await expect(option("Máy-chủ-có-tên-rất-dài").first()).toBeVisible();
    await expectNoHorizontalOverflow([dialog(), dialog().getByRole("listbox"), ...(await options().all())]);
    for (const o of await options().all()) expect((await o.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    const d = (await dialog().boundingBox())!;
    expect(d.x).toBeGreaterThanOrEqual(0);
    expect(d.x + d.width).toBeLessThanOrEqual(w);
    expect(d.y + d.height).toBeLessThanOrEqual(h);
    await page.keyboard.press("Escape");
  }
  await resize(app, 1280, 800);
});

test("opening and closing 20 times leaks nothing: one dialog, one listener (a key toggles exactly once)", async () => {
  const dialogs = await page.locator("dialog").count();
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Control+k");
    await expect(dialog()).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(dialog()).toBeHidden();
  }
  expect(await page.locator("dialog").count()).toBe(dialogs);
  expect(await page.locator("dialog[aria-label='Chuyển nhanh']").count()).toBe(1);
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  await expect(dialog()).toBeVisible();
  await page.keyboard.press("Escape");
  expect(consoleErrors).toEqual([]);
});

test("recents: shown after navigating, kept across a relaunch, never shared between accounts", async () => {
  await openPalette();
  const recents = group("Gần đây");
  await expect(recents).toBeVisible();
  await expect(recents.getByRole("option", { name: new RegExp(C.user.username) })).toBeVisible();
  await expect(recents.getByRole("option", { name: /phong-hai/ })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.evaluate((id) => JSON.parse(localStorage.getItem(`loop.recents.${id}`)!).length, A.user.id)).toBeLessThanOrEqual(8);

  await app.close();
  app = await _electron.launch(launchOptions(userData, FAKE));
  page = await app.firstWindow();
  await expect(rail()).toBeVisible({ timeout: 30_000 });
  await openPalette();
  await expect(group("Gần đây").getByRole("option", { name: /phong-hai/ })).toBeVisible();
  await page.keyboard.press("Escape");

  const signIn = async (s: Session) => {
    await page.getByLabel("Email").fill(`${s.user.username}@example.com`);
    await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
    await page.keyboard.press("Enter");
    await expect(rail()).toBeVisible();
  };
  await page.getByRole("button", { name: "Menu tài khoản" }).click();
  await page.getByRole("button", { name: "Đăng xuất" }).click();
  await signIn(B);
  await openPalette();
  await expect(group("Gần đây")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Menu tài khoản" }).click();
  await page.getByRole("button", { name: "Đăng xuất" }).click();
  await signIn(A);
  await openPalette();
  await expect(group("Gần đây").getByRole("option", { name: /phong-hai/ })).toBeVisible();
  await page.keyboard.press("Escape");
});
