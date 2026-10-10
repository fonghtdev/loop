import { mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type CDPSession, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { api, befriend, connect, expectEllipsis, expectNoHorizontalOverflow, launchAs, makePng, PDF, register, resize, run, uploadAs, type Conn, type Session } from "./helpers";

// 9c attachments in channels and DMs: the real built app (origin app://loop) + dev server + MinIO.
let app: ElectronApplication;
let page: Page;
let cdp: CDPSession;
let A: Session;
let B: Session;
let bConn: Conn;
let guildId = "";
let channelId = "";
let dmId = "";
const dir = join(tmpdir(), `loop-e2e-files-${run}`);
const file = (name: string, bytes: Buffer | string) => {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
};
const guildName = `Tệp ${run}`;
const storage = /^http:\/\/localhost:9000\//;
const apiAttachment = /\/attachments\/[0-9a-f-]{36}$/;

const log = () => page.getByRole("log");
const composer = () => page.getByRole("textbox", { name: /^Nhắn (vào #|cho )/ });
const sendButton = () => page.getByRole("button", { name: "Gửi", exact: true });
const tray = () => page.getByRole("list", { name: "Tệp đính kèm sẽ gửi" });
const trayItem = (name: string | RegExp) => tray().getByRole("listitem").filter({ hasText: name });
const notices = () => page.getByRole("alert").filter({ hasText: /tệp/i });
const pick = async (...paths: string[]) => {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Đính kèm tệp" }).click()]);
  await chooser.setFiles(paths);
};
const rowWithImage = (name: string) => log().getByRole("article").filter({ has: page.getByRole("img", { name, exact: true }) });
const imageIn = (name: string) => log().getByRole("img", { name, exact: true });
const loaded = (img: Locator) => expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
const bytesOf = async (url: string) => Buffer.from(await (await fetch(url)).arrayBuffer());
const openGuild = () => page.getByRole("navigation", { name: "Danh sách máy chủ" }).getByRole("button", { name: guildName }).click();
const openDm = async () => {
  await page.getByRole("button", { name: "Trang chủ" }).click();
  await page.getByRole("list", { name: "Danh sách tin nhắn trực tiếp" }).getByRole("button", { name: new RegExp(B.user.username) }).click();
};
const throttle = (bytesPerSecond: number) => cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: bytesPerSecond });
const attachmentCalls: string[] = []; // every request to POST /attachments

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  mkdirSync(dir, { recursive: true });
  A = await register("aa");
  B = await register("ab");
  const g = await api<{ guild: { id: string }; channels: { id: string }[] }>(A.token, "POST", "/guilds", { name: guildName });
  guildId = g.guild.id;
  channelId = g.channels[0].id;
  const { code } = await api<{ code: string }>(A.token, "POST", `/guilds/${guildId}/invites`, {});
  await api(B.token, "POST", `/invites/${code}/join`);
  await befriend(A, B);
  dmId = (await api<{ id: string }>(B.token, "POST", "/dms", { userId: A.user.id })).id;
  ({ app, page } = await launchAs(A));
  cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  page.on("request", (r) => r.method() === "POST" && /\/attachments$/.test(r.url()) && attachmentCalls.push(r.url()));
  await app.evaluate(({ shell }) => {
    (globalThis as { opened?: string[] }).opened = [];
    shell.openExternal = async (url: string) => void (globalThis as { opened?: string[] }).opened!.push(url);
  });

  bConn = await connect(B);
  expect(await bConn.socket.emitWithAck("channel:subscribe", { channelId })).toEqual({ ok: true });
  await page.getByRole("button", { name: "Trang chủ" }).click();
  await openGuild();
  await expect(log().getByText("Đây là đầu kênh #general")).toBeVisible();
});
test.afterAll(async () => {
  bConn?.close();
  await app?.close();
  if (guildId) await api(A.token, "DELETE", `/guilds/${guildId}`).catch(() => {}); // the guild and its files go; the users stay
});

test("PNG by the file chooser in a channel: progress, Send closed while uploading, then an inline image the other user receives byte for byte", async () => {
  expect(await page.evaluate(() => location.origin)).toMatch(process.env.ELECTRON_RENDERER_URL ? /localhost:5173/ : /^app:\/\/loop$/);
  const png = makePng(64, 48);
  const big = Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]); // a PNG with trailing bytes still decodes
  const path = file("ảnh to.png", big);
  await page.evaluate(() => {
    const seen: number[] = ((window as unknown as { __prog: number[] }).__prog = []);
    new MutationObserver(() => document.querySelectorAll("[role=progressbar]").forEach((e) => seen.push(Number(e.getAttribute("aria-valuenow"))))).observe(document.body, { subtree: true, attributes: true, childList: true });
  });
  const storageResponses: { method: string; status: number; origin: string | null }[] = [];
  page.on("response", async (r) => {
    if (r.request().method() === "PUT" && storage.test(r.url())) storageResponses.push({ method: "PUT", status: r.status(), origin: (await r.request().headerValue("origin")) ?? null });
  });

  await throttle(2_000_000);
  await pick(path);
  await expect(trayItem("ảnh to.png")).toBeVisible();
  await expect(sendButton()).toBeDisabled(); // not ready: the upload is in flight
  await expect(tray().getByRole("progressbar", { name: "ảnh to.png" })).toBeVisible();
  await expect(trayItem("ảnh to.png")).toContainText("6 MB", { timeout: 30_000 });
  await throttle(-1);
  const progress = await page.evaluate(() => (window as unknown as { __prog: number[] }).__prog);
  expect(progress.some((p) => p > 0 && p < 100)).toBe(true);
  expect(progress).toEqual([...progress].sort((a, b) => a - b)); // never goes backwards
  // the browser PUT from the app origin reached MinIO (preflight + CORS ok)
  expect(storageResponses).toEqual([{ method: "PUT", status: 200, origin: process.env.ELECTRON_RENDERER_URL ? "http://localhost:5173" : "app://loop" }]);

  await expect(sendButton()).toBeEnabled(); // an attachment alone is enough
  await sendButton().click();
  const img = imageIn("ảnh to.png");
  await expect(img).toBeVisible();
  await loaded(img);
  expect(await img.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])).toEqual([64, 48]);
  await expect(trayItem("ảnh to.png")).toHaveCount(0);

  await bConn.waitFor("message:new", (m) => m.attachments?.length === 1);
  const msg = bConn.events.filter((e) => e.event === "message:new").at(-1)!.data;
  expect(msg.content).toBe("");
  expect(msg.attachments[0]).toMatchObject({ filename: "ảnh to.png", contentType: "image/png", size: big.length });
  expect(Buffer.compare(await bytesOf(msg.attachments[0].url), big)).toBe(0);
  // the one message is shown once (the sender's own echo is deduped)
  await expect(rowWithImage("ảnh to.png")).toHaveCount(1);
});

test("the in-app viewer: click opens it, Esc closes, focus returns to the thumbnail; backdrop and close button close it too", async () => {
  const thumb = page.getByRole("button", { name: "Xem ảnh ảnh to.png" });
  await thumb.click();
  const viewer = page.getByRole("dialog", { name: "ảnh to.png" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("img", { name: "ảnh to.png" })).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Đóng" })).toBeFocused();
  expect(await viewer.evaluate((el: HTMLDialogElement) => getComputedStyle(el).backdropFilter)).toMatch(/blur/); // the glass primitive
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(thumb).toBeFocused();

  await thumb.click();
  await viewer.getByRole("button", { name: "Đóng" }).click();
  await expect(viewer).toBeHidden();
  await expect(thumb).toBeFocused();

  await thumb.click();
  await page.mouse.click(5, 5); // outside the panel: the backdrop
  await expect(viewer).toBeHidden();
  // the viewer fits the window
  await thumb.click();
  await expect(viewer).toBeVisible();
  const box = await viewer.getByRole("img").boundingBox();
  const win = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(box!.width).toBeLessThanOrEqual(win.width);
  expect(box!.height).toBeLessThanOrEqual(win.height);
  await page.keyboard.press("Escape");
});

test("a PDF becomes a file card (name, type, size); clicking opens a working download link", async () => {
  await pick(file("báo cáo.pdf", PDF));
  await expect(trayItem("báo cáo.pdf")).toContainText(`${PDF.length} B`, { timeout: 10_000 });
  await composer().fill("Tài liệu đây");
  await composer().press("Enter");
  const card = log().getByRole("button", { name: "Tải xuống báo cáo.pdf" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Tài liệu PDF");
  await expect(log().getByText("Tài liệu đây")).toBeVisible();
  await card.click();
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened!.length)).toBe(1);
  const url = (await app.evaluate(() => (globalThis as { opened?: string[] }).opened!))[0];
  const res = await fetch(url);
  expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
  expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), PDF)).toBe(0);
});

test("paste: an image from the clipboard becomes anh-dan.png; plain text still pastes normally", async () => {
  const png = makePng(32, 32, [200, 60, 60]);
  const result = await composer().evaluate(async (el, bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
    const imagePaste = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(imagePaste);
    const text = new DataTransfer();
    text.setData("text/plain", "dán chữ");
    const textPaste = new ClipboardEvent("paste", { clipboardData: text, bubbles: true, cancelable: true });
    el.dispatchEvent(textPaste);
    return { imagePrevented: imagePaste.defaultPrevented, textPrevented: textPaste.defaultPrevented };
  }, Array.from(png));
  expect(result).toEqual({ imagePrevented: true, textPrevented: false });
  await expect(trayItem("anh-dan.png")).toBeVisible();
  await expect(trayItem("anh-dan.png")).toContainText(/\d+ B/, { timeout: 10_000 });
  await tray().getByRole("button", { name: "Bỏ tệp anh-dan.png" }).click();
  await expect(tray()).toHaveCount(0);
});

test("drag and drop: overlay while dragging, files join the tray; a drop elsewhere never navigates the window", async () => {
  const png = makePng(16, 16);
  const main = page.locator("main");
  const drag = (type: string, target: Locator, withFile: boolean) =>
    target.evaluate(
      (el, [t, bytes, withFile]) => {
        const dt = new DataTransfer();
        if (withFile) dt.items.add(new File([new Uint8Array(bytes as number[])], "tha.png", { type: "image/png" }));
        const e = new DragEvent(t as string, { dataTransfer: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      },
      [type, Array.from(png), withFile] as const,
    );
  expect(await drag("dragenter", main.locator("> div").first(), true)).toBe(true);
  await expect(page.getByText("Thả tệp vào đây để đính kèm")).toBeVisible();
  expect(await drag("drop", main.locator("> div").first(), true)).toBe(true);
  await expect(page.getByText("Thả tệp vào đây để đính kèm")).toBeHidden();
  await expect(trayItem("tha.png")).toBeVisible();
  await tray().getByRole("button", { name: "Bỏ tệp tha.png" }).click();

  // a text drag shows no overlay; a file dropped on the rail (outside the conversation) is swallowed, not opened
  expect(await drag("dragenter", main.locator("> div").first(), false)).toBe(false);
  await expect(page.getByText("Thả tệp vào đây để đính kèm")).toBeHidden();
  const href = await page.evaluate(() => location.href);
  expect(await drag("drop", page.getByRole("navigation", { name: "Danh sách máy chủ" }), true)).toBe(true); // the window guard prevented the default
  expect(await page.evaluate(() => location.href)).toBe(href);
  await expect(tray()).toHaveCount(0);
});

test("refused on the client with a Vietnamese reason and NO call to /attachments: over 25 MB, a real .exe, an empty file", async () => {
  const before = attachmentCalls.length;
  const huge = join(dir, "qua-lon.png");
  writeFileSync(huge, "");
  truncateSync(huge, 25 * 1024 * 1024 + 1); // sparse
  await pick(huge, file("tro-choi.exe", Buffer.from("MZ")), file("rong.png", ""));
  await expect(notices()).toContainText("qua-lon.png: tệp quá lớn, tối đa 25 MB.");
  await expect(notices()).toContainText("tro-choi.exe: loại tệp này chưa được hỗ trợ");
  await expect(notices()).toContainText("rong.png: tệp trống nên không thể gửi.");
  await expect(tray()).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(attachmentCalls.length).toBe(before);
  await expect(sendButton()).toBeDisabled();
});

test("at most 10 files per message; many long-named attachments do not overflow the composer (1280x800 and 960x600)", async () => {
  const longName = (i: number) => `${"Đà Nẵng ".repeat(14)}${i}.png`;
  const paths = Array.from({ length: 12 }, (_, i) => file(longName(i), makePng(8 + i, 8)));
  await pick(...paths);
  await expect(tray().getByRole("listitem")).toHaveCount(10);
  await expect(notices()).toContainText("mỗi tin nhắn chỉ đính kèm tối đa 10 tệp");
  await expect(notices().locator("p")).toHaveCount(2);
  for (const [w, h] of [
    [1280, 800],
    [960, 600],
  ] as const) {
    await resize(app, w, h);
    await page.waitForTimeout(250);
    await expectNoHorizontalOverflow([tray(), page.locator("main"), log().locator(".."), notices()]);
    await expectEllipsis(trayItem(longName(0)).locator("span[title]").first());
  }
  await resize(app, 1280, 800);
  for (const i of Array.from({ length: 10 }, (_, k) => k)) await tray().getByRole("button", { name: new RegExp(`^Bỏ tệp .*${i}\\.png$`) }).first().click();
  await expect(tray()).toHaveCount(0);
});

test("a PNG whose bytes are HTML: the server refuses it at complete; it shows as failed with Retry/Remove and blocks Send until removed", async () => {
  await pick(file("gia-mao.png", "<html><script>alert(1)</script></html>"));
  const item = trayItem("gia-mao.png");
  await expect(item).toContainText("Nội dung tệp không khớp với loại của nó", { timeout: 10_000 });
  await expect(item.getByRole("button", { name: "Thử lại tải lên gia-mao.png" })).toBeVisible();
  await composer().fill("kèm tệp lỗi");
  await expect(sendButton()).toBeDisabled(); // failed: neither sent nor lost
  await item.getByRole("button", { name: "Thử lại tải lên gia-mao.png" }).click();
  await expect(item).toContainText("Nội dung tệp không khớp với loại của nó", { timeout: 10_000 }); // retried, refused again
  await item.getByRole("button", { name: "Bỏ tệp gia-mao.png" }).click();
  await expect(tray()).toHaveCount(0);
  await expect(composer()).toHaveValue("kèm tệp lỗi"); // the text was never lost
  await expect(sendButton()).toBeEnabled();
  await composer().fill("");
});

test("removing a file while it uploads stops it; nothing is sent", async () => {
  const sent = bConn.events.length;
  await throttle(500_000);
  await pick(file("se-bo.png", Buffer.concat([makePng(8, 8), Buffer.alloc(3 * 1024 * 1024)])));
  await expect(tray().getByRole("progressbar", { name: "se-bo.png" })).toBeVisible();
  const put = page.waitForEvent("requestfailed", { predicate: (r) => r.method() === "PUT" && storage.test(r.url()), timeout: 10_000 });
  await trayItem("se-bo.png").getByRole("button", { name: "Bỏ tệp se-bo.png" }).click();
  await put; // the XHR was aborted
  await throttle(-1);
  await expect(tray()).toHaveCount(0);
  await expect(sendButton()).toBeDisabled();
  await page.waitForTimeout(500);
  expect(bConn.events.length).toBe(sent);
});

test("an expired image URL: the first failed load fetches ONE fresh URL and the image then shows", async () => {
  let blocked = 0;
  await page.route(storage, async (route) => (route.request().method() === "GET" && blocked++ === 0 ? route.fulfill({ status: 403, body: "expired" }) : route.continue()));
  const fresh: string[] = [];
  const onRequest = (r: { method(): string; url(): string }) => r.method() === "GET" && apiAttachment.test(r.url()) && fresh.push(r.url());
  page.on("request", onRequest);
  const id = await uploadAs(B, { channelId }, "het-han.png", "image/png", makePng(40, 30, [20, 160, 90]));
  await api(B.token, "POST", `/channels/${channelId}/messages`, { attachmentIds: [id] });
  const img = imageIn("het-han.png");
  await loaded(img);
  expect(blocked).toBeGreaterThanOrEqual(2); // the 403, then the successful load
  expect(fresh).toHaveLength(1);
  page.off("request", onRequest);
  await page.unroute(storage);
});

test("an image that never loads: one refresh, then a 'không tải được' placeholder with a Retry button; no loop", async () => {
  await page.route(storage, (route) => (route.request().method() === "GET" ? route.fulfill({ status: 403, body: "gone" }) : route.continue()));
  const fresh: string[] = [];
  const onRequest = (r: { method(): string; url(): string }) => r.method() === "GET" && apiAttachment.test(r.url()) && fresh.push(r.url());
  page.on("request", onRequest);
  const id = await uploadAs(B, { channelId }, "hong.png", "image/png", makePng(40, 30));
  await api(B.token, "POST", `/channels/${channelId}/messages`, { attachmentIds: [id] });
  const article = log().getByRole("article").filter({ hasText: "hong.png" });
  await expect(article.getByText("Không tải được ảnh.")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(fresh).toHaveLength(1); // exactly one refresh, and it stopped
  await article.getByRole("button", { name: "Thử lại" }).click();
  await expect(article.getByText("Không tải được ảnh.")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(fresh).toHaveLength(2); // the user's own retry: one more refresh, not a loop
  page.off("request", onRequest);
  await page.unroute(storage);
  await article.getByRole("button", { name: "Thử lại" }).click();
  await loaded(imageIn("hong.png")); // once the storage answers, Retry works
});

test("HTML in a file name or in a message is text, never markup", async () => {
  const evil = "<img src=x onerror=window.__pwned=1>.png";
  await pick(file(evil, makePng(10, 10)));
  await expect(trayItem(evil)).toContainText(/\d+ B/, { timeout: 10_000 }); // ready: the size line
  await composer().fill('<img src=x onerror="window.__pwned=1"> <b>đậm</b>');
  await composer().press("Enter");
  await expect(log().getByText('<img src=x onerror="window.__pwned=1"> <b>đậm</b>')).toBeVisible();
  await expect(log().getByText(evil, { exact: true })).toBeVisible(); // the caption
  await loaded(imageIn(evil));
  await api(B.token, "POST", `/channels/${channelId}/messages`, { content: "<script>window.__pwned=1</script><svg onload=window.__pwned=1>" });
  await expect(log().getByText("<script>window.__pwned=1</script><svg onload=window.__pwned=1>")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator("img[src='x']").count()).toBe(0);
  expect(await log().locator("b, svg[onload], script").count()).toBe(0);
});

test("edit a message with a file: its text may be emptied; delete removes the message and the file", async () => {
  const id = await uploadAs(A, { channelId }, "sua-xoa.pdf", "application/pdf", PDF);
  const sent = await api<{ id: string; attachments: { url: string }[] }>(A.token, "POST", `/channels/${channelId}/messages`, { content: "sẽ xoá chữ", attachmentIds: [id] });
  const row = log().getByRole("article").filter({ hasText: "sẽ xoá chữ" });
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByRole("button", { name: "Sửa tin nhắn" }).click();
  await page.getByRole("textbox", { name: "Sửa tin nhắn" }).fill("");
  await page.getByRole("textbox", { name: "Sửa tin nhắn" }).press("Enter");
  const file = log().getByRole("article").filter({ has: page.getByRole("button", { name: "Tải xuống sua-xoa.pdf" }) });
  await expect(file.getByText("(đã chỉnh sửa)")).toBeVisible();
  await expect(file.getByText("sẽ xoá chữ")).toHaveCount(0);
  await file.hover();
  await file.getByRole("button", { name: "Xoá tin nhắn" }).click();
  await page.getByRole("dialog", { name: "Xoá tin nhắn?" }).getByText("sua-xoa.pdf").waitFor(); // an empty message shows its file name
  await page.getByRole("dialog", { name: "Xoá tin nhắn?" }).getByRole("button", { name: "Xoá", exact: true }).click();
  await expect(page.getByRole("button", { name: "Tải xuống sua-xoa.pdf" })).toHaveCount(0);
  await expect.poll(async () => (await fetch(sent.attachments[0].url)).status).toBe(404); // the object went with the message
});

test("loading images moves nothing: boxes keep their size and the text below stays where it was", async () => {
  test.setTimeout(120_000);
  const second = await api<{ id: string }>(A.token, "POST", `/guilds/${guildId}/channels`, { name: "cuon", type: "TEXT" });
  const png = makePng(120, 40, [10, 90, 200]);
  for (let i = 1; i <= 70; i++) {
    if (i % 7 === 0) {
      const id = await uploadAs(B, { channelId: second.id }, `cuon-${i}.png`, "image/png", png);
      await api(B.token, "POST", `/channels/${second.id}/messages`, { content: `Ảnh ${i}`, attachmentIds: [id] });
    } else await api(B.token, "POST", `/channels/${second.id}/messages`, { content: `Dòng ${i}` });
  }
  // delay every image so the measurement happens BEFORE any picture arrives, then again after
  await page.route(storage, async (route) => {
    await new Promise((r) => setTimeout(r, 5000));
    await route.continue().catch(() => {});
  });
  await openGuild(); // reopening a server refetches its channels
  await page.getByRole("navigation", { name: "Kênh" }).getByRole("button", { name: "cuon" }).click();
  await expect(log().getByText("Dòng 68", { exact: true })).toBeVisible();
  const scroller = log().locator("..");
  // page up until the oldest message is loaded
  for (let i = 0; i < 6; i++) {
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(250);
  }
  const target = log().getByRole("article").filter({ hasText: "Ảnh 35" });
  await target.scrollIntoViewIfNeeded();
  await scroller.evaluate((el) => (el.scrollTop -= 100));
  const anchor = log().getByRole("article").filter({ hasText: "Dòng 36" });
  const measure = async () => ({
    anchorTop: await anchor.evaluate((el) => el.getBoundingClientRect().top),
    boxes: await log().locator("figure > div").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height))),
    pending: await log().locator("figure img").evaluateAll((els) => els.filter((e) => !(e as HTMLImageElement).complete).length),
  });
  const before = await measure();
  expect(before.pending).toBeGreaterThan(0); // really measured while images were still loading
  await expect.poll(async () => (await measure()).pending, { timeout: 30_000 }).toBe(0);
  const after = await measure();
  expect(after.anchorTop).toBeCloseTo(before.anchorTop, 0);
  expect(after.boxes.slice(0, before.boxes.length)).toEqual(before.boxes);
  expect(new Set(after.boxes).size).toBe(1); // every picture box is the same fixed size
  console.log(`image-load shift: anchor ${before.anchorTop.toFixed(1)} -> ${after.anchorTop.toFixed(1)} px, ${after.boxes.length} boxes of ${after.boxes[0]} px`);
  await page.unroute(storage);
  await page.getByRole("navigation", { name: "Kênh" }).getByRole("button", { name: "general" }).click();
});

test("a message with 10 long-named files and 2000 unbroken characters does not overflow (1280x800 and 960x600)", async () => {
  const names = Array.from({ length: 10 }, (_, i) => `${"Tệp rất dài ".repeat(15)}${i}.${i < 7 ? "png" : "pdf"}`);
  const ids: string[] = [];
  for (const [i, name] of names.entries()) ids.push(await uploadAs(B, { channelId }, name, i < 7 ? "image/png" : "application/pdf", i < 7 ? makePng(20 + i, 20) : PDF));
  await api(B.token, "POST", `/channels/${channelId}/messages`, { content: "L".repeat(2000), attachmentIds: ids });
  const row = log().getByRole("article").filter({ hasText: "LLLLLLLL" });
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  for (const [w, h] of [
    [1280, 800],
    [960, 600],
  ] as const) {
    await resize(app, w, h);
    await page.waitForTimeout(300);
    await expectNoHorizontalOverflow([log(), log().locator(".."), page.locator("main"), row]);
    await expectEllipsis(row.locator("figcaption").first());
    await expectEllipsis(row.locator("button[title] span.truncate").first());
    expect(await row.locator("figure").first().evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(320);
  }
  await resize(app, 1280, 800);
});

test("in a DM: PNG by the chooser shows inline and the other user gets it byte for byte; a PDF is a card", async () => {
  await openDm();
  await expect(composer()).toBeEnabled();
  const png = makePng(50, 50, [250, 200, 20]);
  await pick(file("dm.png", png));
  await expect(trayItem("dm.png")).toContainText(/\d+ B/, { timeout: 10_000 });
  await sendButton().click();
  const img = imageIn("dm.png");
  await loaded(img);
  await bConn.waitFor("dm:message:new", (m) => m.attachments?.some((a: { filename: string }) => a.filename === "dm.png"));
  const msg = bConn.events.filter((e) => e.event === "dm:message:new").at(-1)!.data;
  expect(msg.dmChannelId).toBe(dmId);
  expect(Buffer.compare(await bytesOf(msg.attachments[0].url), png)).toBe(0);
  await expect(rowWithImage("dm.png")).toHaveCount(1);

  const id = await uploadAs(B, { dmChannelId: dmId }, "tu-b.pdf", "application/pdf", PDF);
  await api(B.token, "POST", `/dms/${dmId}/messages`, { content: "file từ B", attachmentIds: [id] });
  await expect(log().getByRole("button", { name: "Tải xuống tu-b.pdf" })).toBeVisible();
  await expect(log().getByText("file từ B")).toBeVisible();
});
