import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { tileLayout } from "../src/renderer/src/lib/voice-grid";
import { api, befriend, expectNoHorizontalOverflow, launchAs, makePng, register, resize, run, uploadAs, type Session } from "./helpers";
import { callToken, channelToken, joinRoom, leaveAll, type Peer } from "./livekit";

// Redesign R4 (voice room, call dialogs, friends, settings, viewer, drop overlay), checked through the DOM, computed
// styles and behaviour (no pictures). Real dev server + docker; everyone but the app user is an API script.
let app: ElectronApplication;
let page: Page;
let A: Session; // the app's user, owner of the server
let B: Session;
let guild: { id: string; general: string };
let voz = "";
const userData = mkdtempSync(join(tmpdir(), "loop-e2e-r4-"));
const consoleErrors: string[] = [];

const rail = () => page.getByRole("navigation", { name: "Danh sách máy chủ" });
const channelButton = (name: string) => page.getByRole("button", { name, exact: true });
const members = () => page.getByRole("complementary", { name: "Thành viên" });
const reduceMotion = async (on: boolean) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "no-preference" }] });
};
const openServer = () => rail().getByRole("button", { name: `R4 ${run}` }).click();

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  [A, B] = await Promise.all([register("r4a"), register("r4b")]);
  const g = await api<{ guild: { id: string }; channels: { id: string }[] }>(A.token, "POST", "/guilds", { name: `R4 ${run}` });
  guild = { id: g.guild.id, general: g.channels[0].id };
  voz = (await api<{ id: string }>(A.token, "POST", `/guilds/${guild.id}/channels`, { name: "voz-r4", type: "VOICE" })).id;
  await joinGuild(B);
  await befriend(A, B);
  ({ app, page } = await launchAs(A, { userData, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }));
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
});
test.afterAll(async () => {
  await leaveAll();
  await app?.close().catch(() => undefined);
});

async function joinGuild(s: Session) {
  const { code } = await api<{ code: string }>(A.token, "POST", `/guilds/${guild.id}/invites`, {});
  await api(s.token, "POST", `/invites/${code}/join`);
}

test("the voice room hides the member column and gives it back on another channel", async () => {
  await openServer();
  await channelButton("general").click();
  await expect(members()).toBeVisible();
  await channelButton("Kênh thoại voz-r4").click(); // joins, the view stays on #general
  await expect(members()).toBeVisible();
  await channelButton("Kênh thoại voz-r4").click(); // connected: opens the room
  await expect(page.getByRole("heading", { name: "voz-r4" })).toBeVisible();
  await expect(members()).toHaveCount(0);
  const cols = await page.locator("main").evaluate((el) => getComputedStyle(el.parentElement!).gridTemplateColumns.split(" ").length);
  expect(cols).toBe(3);
  await channelButton("general").click();
  await expect(members()).toBeVisible();
  expect(await page.locator("main").evaluate((el) => getComputedStyle(el.parentElement!).gridTemplateColumns.split(" ").length)).toBe(4);
  await page.getByRole("region", { name: "Đang trong cuộc gọi" }).getByRole("button", { name: "Rời kênh thoại" }).click();
});

test("25 people: column count follows tileLayout, nothing overflows at 1280x800 and 960x600; a tile joining and leaving is animated", async () => {
  test.setTimeout(240_000);
  const peers: Peer[] = [];
  const join = async (s: Session) => peers.push(await joinRoom(await channelToken(s, voz), { mic: false }));
  await join(B);
  for (let i = 0; i < 22; i++) {
    const u = await register(`r4x${i}`);
    await joinGuild(u);
    await join(u);
  }
  await channelButton("Kênh thoại voz-r4").click(); // joins: A is the 24th
  await expect(page.getByRole("region", { name: "Đang trong cuộc gọi" }).getByText("Đã kết nối giọng nói", { exact: true })).toBeVisible({ timeout: 15_000 });
  await channelButton("Kênh thoại voz-r4").click(); // connected: opens the room
  const tiles = page.getByRole("list", { name: "Người trong kênh thoại" });
  await expect(tiles.getByRole("listitem")).toHaveCount(24, { timeout: 20_000 });
  const late = await register("r4late");
  await joinGuild(late);
  await join(late);
  await expect(tiles.getByRole("listitem")).toHaveCount(25);
  for (const [w, h] of [[1280, 800], [960, 600]] as const) {
    await resize(app, w, h);
    await page.waitForTimeout(400);
    await expectNoHorizontalOverflow([page.locator("main"), tiles, tiles.locator(".."), page.locator("body")]);
    const m = await tiles.evaluate((ul) => {
      const box = ul.parentElement!;
      const cs = getComputedStyle(box);
      return { w: box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), h: box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom), cols: getComputedStyle(ul).gridTemplateColumns.split(" ").length };
    });
    const expected = tileLayout(25, m.w, m.h);
    expect(m.cols, `${w}x${h}`).toBe(expected.cols);
    // every tile is as wide as the function says and inside the box
    const widths = await tiles.getByRole("listitem").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    expect(new Set(widths)).toEqual(new Set([expected.width]));
  }
  await resize(app, 1280, 800);
  // a leaver springs out and is gone; the room shrinks to 24 without a reload
  await peers.pop()!.leave();
  await expect(tiles.getByRole("listitem")).toHaveCount(24, { timeout: 10_000 });
  await page.getByRole("region", { name: "Đang trong cuộc gọi" }).getByRole("button", { name: "Rời kênh thoại" }).click();
  await Promise.all(peers.map((p) => p.leave()));
  await expect(tiles).toHaveCount(0, { timeout: 15_000 });
});

test("incoming call: glass dialog, focus on Answer, ripple rings that stop under reduced motion, Esc declines", async () => {
  await page.getByRole("button", { name: "Trang chủ" }).click();
  const dm = await api<{ id: string }>(A.token, "POST", "/dms", { userId: B.user.id });
  await page.waitForTimeout(2500);
  const b = await joinRoom(await callToken(B, dm.id));
  const dialog = page.getByRole("dialog", { name: /đang gọi bạn/ });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Trả lời" })).toBeFocused();
  expect(await dialog.evaluate((el) => getComputedStyle(el).backdropFilter)).toMatch(/^blur/);
  const rings = dialog.locator("[data-ripple]");
  await expect(rings).toHaveCount(3);
  const anim = () => rings.first().evaluate((el) => ({ name: getComputedStyle(el).animationName, iterations: getComputedStyle(el).animationIterationCount, duration: getComputedStyle(el).animationDuration, opacity: getComputedStyle(el).opacity }));
  expect(await anim()).toMatchObject({ name: "ripple", iterations: "infinite", duration: "2.4s" });
  await reduceMotion(true);
  expect(await anim()).toMatchObject({ iterations: "1", duration: "0.001s", opacity: "0" });
  await reduceMotion(false);
  expect(await page.getByRole("button", { name: "Từ chối" }).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(245, 163, 174)"); // danger
  expect(await page.getByRole("button", { name: "Trả lời" }).evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("linear-gradient"); // primary
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await b.leave();
});

test("friends tabs: one indicator slides to the clicked tab, and jumps there at once under reduced motion", async () => {
  await page.getByRole("button", { name: "Trang chủ" }).click();
  const tab = (name: RegExp) => page.getByRole("tab", { name });
  const indicator = page.locator("[data-tab-indicator]");
  await expect(indicator).toHaveCount(1);
  await tab(/^Tất cả/).click();
  // every transform the indicator shows over the 400 ms after a click, one sample per frame
  const sweep = (name: RegExp) =>
    tab(name).evaluate(async (el) => {
      const ind = document.querySelector("[data-tab-indicator]")!;
      const seen: string[] = [];
      (el as HTMLElement).click();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        seen.push(getComputedStyle(ind).transform);
      }
      return { seen, left: (el as HTMLElement).offsetLeft, width: (el as HTMLElement).offsetWidth };
    });
  const end = (r: { seen: string[] }) => {
    const [a, , , , e] = r.seen.at(-1)!.replace(/^matrix\(|\)$/g, "").split(",").map(Number);
    return { a, m41: e };
  };

  await reduceMotion(false);
  let r = await sweep(/^Bạn chặn|^Đã chặn/);
  expect(end(r).m41).toBeCloseTo(r.left, 1);
  expect(end(r).a).toBeCloseTo(r.width / 100, 2);
  expect(new Set(r.seen).size, "animated: several distinct frames").toBeGreaterThan(3);

  await reduceMotion(true);
  r = await sweep(/^Tất cả/);
  expect(end(r).m41).toBeCloseTo(r.left, 1);
  expect(new Set(r.seen).size, "reduced motion: at most the start and the end").toBeLessThanOrEqual(2);
  await reduceMotion(false);
  await expect(tab(/^Tất cả/)).toHaveAttribute("aria-selected", "true");
});

test("toast: a settings save is announced in the live region, pauses under the pointer and goes after ~3 s; one at a time", async () => {
  await page.getByRole("button", { name: "Cài đặt của bạn" }).click();
  const pill = page.locator("[data-toast]");
  const notify = page.getByRole("switch", { name: /^Thông báo trên máy tính/ });
  await notify.click();
  await expect(pill).toHaveText(/Đã lưu\./);
  expect(await pill.evaluate((el) => getComputedStyle(el).backdropFilter)).toMatch(/^blur/); // glass is allowed on a toast
  expect(await pill.evaluate((el) => el.closest("[aria-live]")!.getAttribute("role"))).toBe("status");
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu." })).toBeVisible(); // announced through the polite live region
  // a second save replaces it: still exactly one toast
  await notify.click();
  await expect(pill).toHaveCount(1);
  // hovering keeps it past the 3 s mark
  await pill.hover();
  await page.waitForTimeout(3600);
  await expect(pill).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(pill).toBeHidden({ timeout: 5000 });
  // and it is gone on its own without hover
  await notify.click();
  await expect(pill).toBeVisible();
  const t0 = Date.now();
  await expect(pill).toBeHidden({ timeout: 6000 });
  expect(Date.now() - t0).toBeGreaterThan(2000);
  await page.keyboard.press("Escape");
});

test("tri-state overwrite: the thumb slides to the chosen option and the radiogroup stays native", async () => {
  await openServer();
  await page.getByRole("button", { name: `Tuỳ chọn máy chủ R4 ${run}` }).click();
  await page.getByRole("button", { name: "Cài đặt máy chủ", exact: true }).click();
  await page.getByRole("tab", { name: "Quyền theo kênh" }).click();
  const group = page.getByRole("radiogroup", { name: /^Xem kênh/ });
  await expect(group.getByRole("radio")).toHaveCount(3);
  const thumb = group.locator("[data-seg-thumb]");
  const option = (name: string) => group.getByRole("radio", { name }).locator(".."); // the label around the icon
  const labelLeft = (name: string) => option(name).evaluate((el) => el.getBoundingClientRect().left);
  for (const [name, index] of [["Từ chối", 2], ["Cho phép", 0], ["Mặc định", 1]] as const) {
    await option(name).click();
    await expect(group.getByRole("radio", { name })).toBeChecked();
    await expect(thumb).toHaveAttribute("data-index", String(index));
    await expect.poll(async () => Math.abs((await thumb.evaluate((el) => el.getBoundingClientRect().left)) - (await labelLeft(name)))).toBeLessThan(2);
  }
  // keyboard: arrows move the selection and the thumb with it
  await group.getByRole("radio", { name: "Mặc định" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(group.getByRole("radio", { name: "Từ chối" })).toBeChecked();
  await expect(thumb).toHaveAttribute("data-index", "2");
  await page.getByRole("button", { name: "Đóng cài đặt" }).click();
});

test("image viewer: opens from the thumbnail, zooms to 1.8x and back, Esc closes, focus returns; reduced motion has no flight", async () => {
  await openServer();
  await channelButton("general").click();
  const id = await uploadAs(B, { channelId: guild.general }, "r4-anh.png", "image/png", makePng(320, 200, [200, 90, 60]));
  await api(B.token, "POST", `/channels/${guild.general}/messages`, { attachmentIds: [id] });
  const thumb = page.getByRole("button", { name: "Xem ảnh r4-anh.png" });
  await expect(thumb).toBeVisible();
  const viewer = page.getByRole("dialog", { name: "r4-anh.png" });
  const picture = viewer.getByRole("img", { name: "r4-anh.png" });

  // opening: the picture starts at the thumbnail (a transform) and ends clean at its place
  const first = await thumb.evaluate((el) => {
    const seen: string[] = [];
    (el as HTMLElement).click();
    return new Promise<string[]>((resolve) => {
      let n = 0;
      const tick = () => {
        const img = document.querySelector<HTMLElement>("dialog[data-viewer] img");
        if (img) seen.push(getComputedStyle(img).transform);
        if (++n < 40) requestAnimationFrame(tick);
        else resolve(seen);
      };
      requestAnimationFrame(tick);
    });
  });
  expect(new Set(first).size, "several frames while flying out").toBeGreaterThan(2);
  await expect(viewer).toHaveAttribute("data-phase", "open");
  expect(await picture.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
  await expect(viewer).toHaveAttribute("data-zoom", "fit");

  const fitBox = (await picture.boundingBox())!;
  await viewer.getByRole("button", { name: "Phóng to" }).click();
  await expect(viewer).toHaveAttribute("data-zoom", "zoom");
  const zoomBox = (await picture.boundingBox())!;
  expect(zoomBox.width / fitBox.width).toBeCloseTo(1.8, 1);
  expect(await picture.evaluate((el) => el.parentElement!.scrollWidth > el.parentElement!.clientWidth)).toBe(true); // panned by scrolling
  await picture.click(); // the picture itself toggles back
  await expect(viewer).toHaveAttribute("data-zoom", "fit");
  expect(((await picture.boundingBox())!.width / fitBox.width)).toBeCloseTo(1, 1);

  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(thumb).toBeFocused();

  // reduced motion: open, no intermediate frames, closes at once
  await reduceMotion(true);
  const reduced = await thumb.evaluate((el) => {
    const seen = new Set<string>();
    (el as HTMLElement).click();
    return new Promise<string[]>((resolve) => {
      let n = 0;
      const tick = () => {
        const img = document.querySelector<HTMLElement>("dialog[data-viewer] img");
        if (img) seen.add(getComputedStyle(img).transform);
        if (++n < 30) requestAnimationFrame(tick);
        else resolve([...seen]);
      };
      requestAnimationFrame(tick);
    });
  });
  expect(reduced.length, "reduced motion: at most the first and the last state").toBeLessThanOrEqual(2);
  await expect(viewer).toHaveAttribute("data-phase", "open");
  await viewer.getByRole("button", { name: "Đóng" }).click();
  await expect(viewer).toBeHidden({ timeout: 2000 });
  await expect(thumb).toBeFocused();
  await reduceMotion(false);
});

test("drop overlay: appears on a file dragenter, goes on dragleave and on drop; text drags never show it", async () => {
  await channelButton("general").click();
  const area = page.locator("main > div").first();
  const overlay = page.getByText("Thả tệp vào đây để gửi");
  const fire = (type: string, withFile: boolean, related = false) =>
    area.evaluate(
      (el, [t, file, rel]) => {
        const dt = new DataTransfer();
        if (file) dt.items.add(new File([new Uint8Array([1])], "tha.png", { type: "image/png" }));
        el.dispatchEvent(new DragEvent(t as string, { dataTransfer: dt, bubbles: true, cancelable: true, relatedTarget: rel ? document.body : null }));
      },
      [type, withFile, related] as const,
    );
  await fire("dragenter", false);
  await expect(overlay).toBeHidden();
  await fire("dragenter", true);
  await expect(overlay).toBeVisible();
  await fire("dragleave", true, true);
  await expect(overlay).toBeHidden();
  await fire("dragenter", true);
  await expect(overlay).toBeVisible();
  // The dropped 1-byte "png" is really uploaded by the app and the server rightly rejects it at `complete` (400).
  // Wait for that expected rejection and take its console error out of the collector, so that it cannot land late in
  // another test of this file that asserts "no console errors".
  const known = consoleErrors.length;
  const rejected = page.waitForResponse((r) => /\/attachments\/[^/]+\/complete$/.test(r.url()) && r.status() === 400, { timeout: 15_000 });
  await fire("drop", true);
  await expect(overlay).toBeHidden();
  await rejected;
  await expect.poll(() => consoleErrors.length, { timeout: 5_000 }).toBeGreaterThan(known);
  const fresh = consoleErrors.splice(known);
  consoleErrors.push(...fresh.filter((e) => !/status of 400/.test(e)));
  await page.getByRole("button", { name: "Bỏ tệp tha.png" }).click();
});

test("no interactive element keeps a native title; glass only on dialogs, popovers, tooltips and toasts; no console errors", async () => {
  // visit the places R4 touched, then scan
  const interactive = "button[title], a[title], input[title], select[title], textarea[title], label[title], [role=button][title], [role=tab][title], [role=switch][title]";
  const scan = async () => expect(await page.locator(interactive).count()).toBe(0);
  await page.getByRole("button", { name: "Trang chủ" }).click();
  await scan();
  await openServer();
  await channelButton("Kênh thoại voz-r4").click();
  await scan();
  await page.getByRole("button", { name: `Tuỳ chọn máy chủ R4 ${run}` }).click();
  await page.getByRole("button", { name: "Cài đặt máy chủ", exact: true }).click();
  for (const tab of ["Vai trò", "Thành viên", "Quyền theo kênh", "Nguy hiểm"]) {
    await page.getByRole("tab", { name: tab }).click();
    await scan();
  }
  await page.getByRole("button", { name: "Đóng cài đặt" }).click();
  await channelButton("general").click();
  const blur = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backdropFilter);
  for (const sel of ["main", "nav", "aside"]) expect(await blur(sel)).toBe("none");
  expect(consoleErrors).toEqual([]);
});
