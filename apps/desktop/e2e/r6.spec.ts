import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { api, befriend, expectNoHorizontalOverflow, launchAs, register, resize, run, type Session } from "./helpers";
import { callToken, channelToken, joinRoom, leaveAll } from "./livekit";

// Voice UX: joining never navigates, the bottom user/voice panel, mic / headphones marks, device menus.
let app: ElectronApplication;
let page: Page;
let A: Session;
let B: Session;
let guildName: string;
let voz: string;
const consoleErrors: string[] = [];

const rail = () => page.getByRole("navigation", { name: "Danh sách máy chủ" });
const channels = () => page.getByRole("list", { name: "Danh sách kênh" });
const channelButton = (name: string) => page.getByRole("button", { name: `Kênh thoại ${name}`, exact: true });
const bar = () => page.getByRole("region", { name: "Đang trong cuộc gọi" });
const strip = () => page.getByRole("region", { name: "Tài khoản" });
const panel = () => page.locator("[data-panel]");
const grid = () => page.getByRole("list", { name: "Người trong kênh thoại" });
const rows = (name: string) => page.getByRole("list", { name: `Người đang ở trong kênh ${name}` });
const composer = (name: string) => page.getByRole("textbox", { name: `Nhắn vào #${name}` });
const mic = () => strip().getByRole("button", { name: "Tắt micro" });
const deafen = () => strip().getByRole("button", { name: "Tắt tiếng nghe" });
const connected = () => expect(bar().getByText(/^Đã kết nối (giọng nói|cuộc gọi)$/)).toBeVisible({ timeout: 20_000 });
const leave = async () => {
  await bar().getByRole("button", { name: /^(Rời kênh thoại|Kết thúc cuộc gọi)$/ }).click();
  await expect(bar()).toBeHidden();
};
const marks = (list: ReturnType<typeof grid>, id: string) => list.locator(`li[data-user="${id}"]`).locator("[data-indicators]");
const palette = () => page.getByRole("dialog", { name: "Chuyển nhanh" });

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  [A, B] = await Promise.all([register("r6a"), register("r6b")]);
  await befriend(A, B);
  guildName = `R6 ${run}`;
  const { guild } = await api<{ guild: { id: string } }>(A.token, "POST", "/guilds", { name: guildName });
  voz = (await api<{ id: string }>(A.token, "POST", `/guilds/${guild.id}/channels`, { name: "voz-r6", type: "VOICE" })).id;
  await api(A.token, "POST", `/guilds/${guild.id}/channels`, { name: "voz-r6b", type: "VOICE" });
  const { code } = await api<{ code: string }>(A.token, "POST", `/guilds/${guild.id}/invites`, {});
  await api(B.token, "POST", `/invites/${code}/join`);
  // enough servers and channels that the rail and the channel list must scroll
  for (let i = 0; i < 12; i++) await api(A.token, "POST", "/guilds", { name: `Phụ ${i} ${run}` });
  for (let i = 0; i < 24; i++) await api(A.token, "POST", `/guilds/${guild.id}/channels`, { name: `kenh-${i}`, type: "TEXT" });
  ({ app, page } = await launchAs(A, { userData: mkdtempSync(join(tmpdir(), "loop-e2e-r6-")), args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }));
  await resize(app, 1280, 800);
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await rail().getByRole("button", { name: guildName }).click();
  await channels().getByRole("button", { name: "general", exact: true }).click();
});
test.afterAll(async () => {
  await leaveAll();
  await app?.close().catch(() => undefined);
});

test("not in a call: the strip is there, mic and headphones are disabled with a reason, the gear works", async () => {
  await expect(bar()).toBeHidden();
  await expect(strip().getByText("Trực tuyến").first()).toBeVisible();
  await expect(strip().getByText(`${A.user.username}@example.com`)).toBeHidden(); // the email is only in the closed account menu
  await expect(mic()).toBeDisabled();
  await expect(deafen()).toBeDisabled();
  await expect(strip().getByRole("button", { name: "Chọn micro" })).toBeVisible();
  await strip().getByRole("button", { name: "Cài đặt của bạn" }).click();
  await expect(page.getByRole("heading", { name: "Cài đặt của bạn" })).toBeVisible();
  await channels().getByRole("button", { name: "general", exact: true }).click();
  await expect(composer("general")).toBeVisible();
});

test("joining from a text channel keeps the main area; the connected channel (and the panel button) opens the room; joining another keeps the view", async () => {
  await channelButton("voz-r6").click();
  await connected();
  await expect(composer("general")).toBeVisible();
  await expect(grid()).toHaveCount(0);
  await expect(bar()).toContainText(`voz-r6 / ${guildName}`);
  await channelButton("voz-r6").click(); // already connected: opens the room
  await expect(page.getByRole("heading", { name: "voz-r6" })).toBeVisible();
  await expect(grid().getByRole("listitem")).toHaveCount(1);
  await channels().getByRole("button", { name: "general", exact: true }).click();
  await bar().getByRole("button", { name: "Mở phòng thoại" }).click();
  await expect(page.getByRole("heading", { name: "voz-r6" })).toBeVisible();
  // Ctrl+K follows the same rule: it joins the other channel, the view stays on the first room
  await page.keyboard.press("Control+k");
  await palette().getByRole("combobox").fill("voz-r6b");
  await page.keyboard.press("Enter");
  await expect(bar()).toContainText("voz-r6b /");
  await expect(page.getByRole("heading", { name: "voz-r6", exact: true })).toBeVisible();
  await channelButton("voz-r6").click(); // not connected to it any more: joins again, no navigation
  await expect(bar()).toContainText("voz-r6 /");
  await leave();
});

test("one solid card across the rail and the channel column; nothing hides behind it; no overflow", async () => {
  await channelButton("voz-r6").click();
  await connected();
  for (const [w, h] of [[1280, 800], [960, 600]]) {
    await resize(app, w, h);
    const [p, r, c] = await Promise.all([panel().boundingBox(), rail().boundingBox(), channels().boundingBox()]);
    const nav = (await page.getByRole("navigation", { name: "Kênh" }).boundingBox().catch(() => null)) ?? c!;
    expect(p!.x).toBeLessThanOrEqual(r!.x + 12);
    expect(p!.x + p!.width).toBeGreaterThanOrEqual(nav.x + nav.width - 12);
    expect(p!.width).toBeGreaterThan(r!.width + 200); // rail (72) + channel column (240) minus the margins
    expect(p!.y).toBeGreaterThanOrEqual(r!.y + r!.height - 1);
    // the last server and the last channel are reachable by scrolling and end above the card
    const lastServer = rail().getByRole("button").last();
    await lastServer.scrollIntoViewIfNeeded();
    expect((await lastServer.boundingBox())!.y + (await lastServer.boundingBox())!.height).toBeLessThanOrEqual(p!.y);
    const lastChannel = channels().getByRole("button").last();
    await lastChannel.scrollIntoViewIfNeeded();
    expect((await lastChannel.boundingBox())!.y + (await lastChannel.boundingBox())!.height).toBeLessThanOrEqual(p!.y);
    await expectNoHorizontalOverflow([panel(), strip(), bar(), page.locator("body")]);
    for (const b of await panel().getByRole("button").all()) if (await b.isVisible()) expect((await b.boundingBox())!.height, (await b.getAttribute("aria-label")) ?? "button").toBeGreaterThanOrEqual(40);
  }
  await resize(app, 1280, 800);
  expect(await panel().evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none"); // solid, not glass
  await leave();
});

test("mic muted shows one mark, deafened shows both - in the channel list row AND on the tile", async () => {
  await channelButton("voz-r6").click();
  await connected();
  await channelButton("voz-r6").click(); // open the room
  const row = marks(rows("voz-r6"), A.user.id);
  const tile = marks(grid(), A.user.id);
  await expect(row).toHaveCount(0);
  await expect(tile).toHaveCount(0);
  await mic().click();
  await expect(row).toHaveAttribute("data-indicators", "mic");
  await expect(tile).toHaveAttribute("data-indicators", "mic");
  await mic().click();
  await expect(tile).toHaveCount(0);
  await deafen().click();
  await expect(deafen()).toHaveAttribute("aria-pressed", "true");
  await expect(mic()).toHaveAttribute("aria-pressed", "true"); // both look pressed
  await expect(row).toHaveAttribute("data-indicators", "mic deaf");
  await expect(tile).toHaveAttribute("data-indicators", "mic deaf");
  await expect(tile).toContainText("Đã tắt tiếng nghe");
  await deafen().click();
  await expect(tile).toHaveCount(0);
  await leave();
});

test("someone else: their muted mic and their deafen flag show on their tile and row", async () => {
  const b = await joinRoom(await channelToken(B, voz));
  await channelButton("voz-r6").click();
  await connected();
  await channelButton("voz-r6").click();
  const tile = marks(grid(), B.user.id);
  const row = marks(rows("voz-r6"), B.user.id);
  await expect(grid().getByRole("listitem")).toHaveCount(2);
  await expect(tile).toHaveCount(0);
  await b.muteMic(true);
  await expect(tile).toHaveAttribute("data-indicators", "mic");
  await expect(row).toHaveAttribute("data-indicators", "mic");
  await b.setMetadata(JSON.stringify({ deafened: true })); // needs canUpdateOwnMetadata from the token
  await expect(tile).toHaveAttribute("data-indicators", "mic deaf");
  await b.setMetadata("{not json"); // malformed: ignored, not a crash
  await expect(tile).toHaveAttribute("data-indicators", "mic");
  await b.muteMic(false);
  await expect(tile).toHaveCount(0);
  await b.leave();
  await leave();
});

test("the chevron menus list the devices, mark the current one and apply the choice", async () => {
  await channelButton("voz-r6").click();
  await connected();
  await strip().getByRole("button", { name: "Chọn micro" }).click();
  const items = page.locator("#menu-mic-devices").getByRole("button");
  await expect.poll(() => items.count()).toBeGreaterThanOrEqual(2); // system default + the fake microphone(s)
  expect(await items.first().getAttribute("aria-pressed")).toBe("true"); // default is current
  expect(await page.locator("#menu-mic-devices").evaluate((el) => getComputedStyle(el).backdropFilter)).not.toBe("none"); // glass on the popover
  const pick = items.nth(1);
  const label = (await pick.innerText()).trim();
  await pick.click();
  await expect(page.locator("#menu-mic-devices")).toBeHidden();
  await strip().getByRole("button", { name: "Chọn micro" }).click();
  await expect(page.locator("#menu-mic-devices").getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await strip().getByRole("button", { name: "Chọn loa" }).click();
  await expect(page.locator("#menu-speaker-devices").getByRole("button").first()).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await strip().getByRole("button", { name: "Cài đặt của bạn" }).click(); // the settings picker shows the same choice
  await expect(page.getByLabel("Micro", { exact: true }).locator("option:checked")).toHaveText(label);
  await page.getByLabel("Micro", { exact: true }).selectOption("");
  await leave();
});

test("a DM call: the panel says it is a call, names the other person, has no room button", async () => {
  const dmId = (await api<{ id: string }>(A.token, "POST", "/dms", { userId: B.user.id })).id;
  await page.waitForTimeout(2500); // LiveKit drops the previous room's people a moment late; the server rings only an empty room
  const b = await joinRoom(await callToken(B, dmId, false));
  await page.getByRole("button", { name: "Trả lời" }).click();
  await connected();
  await expect(bar()).toContainText("Đã kết nối cuộc gọi");
  await expect(bar()).toContainText(B.user.username);
  await expect(bar().getByRole("button", { name: "Kết thúc cuộc gọi" })).toBeVisible();
  await expect(bar().getByRole("button", { name: "Mở phòng thoại" })).toHaveCount(0);
  await expect(mic()).toBeEnabled();
  await leave();
  await b.leave();
});

test("no native title anywhere in the panel, no console errors; logout from the settings screen still works", async () => {
  expect(await page.locator("button[title], [role=button][title], a[title]").count()).toBe(0);
  await strip().getByRole("button", { name: "Menu tài khoản" }).click();
  await expect(page.locator("#menu-account").getByRole("button", { name: "Đăng xuất" })).toBeVisible(); // logout is in the name's menu
  await page.keyboard.press("Escape");
  expect(consoleErrors).toEqual([]);
  await strip().getByRole("button", { name: "Cài đặt của bạn" }).click();
  await page.getByRole("main").getByRole("button", { name: "Đăng xuất" }).click(); // and in the settings screen
  await expect(page.getByLabel("Email")).toBeVisible();
});
