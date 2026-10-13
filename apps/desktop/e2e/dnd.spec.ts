import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { api, launchAs, resize, run, type Session } from "./helpers";

// Channel column drag and drop (native HTML5 DnD driven by real mouse events): categories, channels, empty/collapsed
// categories, the uncategorised area, a plain member that cannot drag, file drags vs internal drags, rollback.
// Real dev server + docker.
let A: Session;
let B: Session; // plain member
let app: ElectronApplication;
let page: Page;
let member: { app: ElectronApplication; page: Page };
let guildId: string;
const userData = mkdtempSync(join(tmpdir(), "loop-e2e-dnd-"));

const list = (p: Page) => p.getByRole("list", { name: "Danh sách kênh" });
const rail = (p: Page) => p.getByRole("navigation", { name: "Danh sách máy chủ" });
const header = (p: Page, name: string) => list(p).getByRole("button", { name, exact: true });
const channel = (p: Page, name: string) => list(p).getByRole("button", { name, exact: true });
const names = (p: Page) => list(p).getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent?.trim() ?? "").filter((n) => !/^(Tạo kênh|Tuỳ chọn)/.test(n)));
const orderIs = (p: Page, expected: string[]) => expect.poll(() => names(p)).toEqual(expected);
const overlay = (p: Page) => p.getByText("Thả tệp vào đây để gửi");

/** Real mouse drag: down on the source, a few moves, up on a point of the target (fraction of its box). */
async function drag(source: Locator, target: Locator, at: "top" | "middle" | "bottom" = "middle") {
  const s = (await source.boundingBox())!;
  const p = source.page();
  await p.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await p.mouse.down();
  await p.mouse.move(s.x + s.width / 2 + 4, s.y + s.height / 2 + 4, { steps: 3 });
  const t = (await target.boundingBox())!;
  const y = at === "top" ? t.y + 3 : at === "bottom" ? t.y + t.height - 3 : t.y + t.height / 2;
  await p.mouse.move(t.x + t.width / 2, y, { steps: 8 });
  await p.mouse.move(t.x + t.width / 2, y + 0.5);
  // a drop is over once the refetch after its PUT is back: a new drag is refused while one is in flight (by design)
  await Promise.all([p.waitForResponse((r) => r.request().method() === "GET" && /\/guilds\/[^/]+$/.test(r.url())), p.mouse.up()]);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const reg = async (tag: string) => {
    const username = `${tag}_${run}`.toLowerCase();
    const r = await api<{ accessToken: string; user: Session["user"] }>(null, "POST", "/auth/register", { email: `${username}@example.com`, username, password: "correct-horse-battery" });
    return { token: r.accessToken, user: r.user };
  };
  [A, B] = await Promise.all([reg("dnda"), reg("dndb")]);
  const g = await api<{ guild: { id: string }; categories: { id: string; name: string }[] }>(A.token, "POST", "/guilds", { name: `Kéo thả ${run}` });
  guildId = g.guild.id;
  // layout: tu-do | Alpha: a1 a2 | Beta: b1 | Gamma: (empty) | Kênh văn bản: general | Kênh thoại: (empty)
  const cat = async (name: string) => (await api<{ id: string }>(A.token, "POST", `/guilds/${guildId}/categories`, { name })).id;
  const [alpha, beta] = [await cat("Alpha"), await cat("Beta")];
  await cat("Gamma");
  const ch = (name: string, categoryId?: string) => api(A.token, "POST", `/guilds/${guildId}/channels`, { name, type: "TEXT", ...(categoryId && { categoryId }) });
  await ch("tu-do");
  await ch("a1", alpha);
  await ch("a2", alpha);
  await ch("b1", beta);
  const { code } = await api<{ code: string }>(A.token, "POST", `/guilds/${guildId}/invites`, {});
  await api(B.token, "POST", `/invites/${code}/join`);
  ({ app, page } = await launchAs(A, { userData }));
  await resize(app, 1280, 900);
  member = await launchAs(B);
  for (const p of [page, member.page]) await rail(p).getByRole("button", { name: `Kéo thả ${run}` }).click();
  await expect(header(page, "Gamma")).toBeVisible();
});
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await member?.app.close().catch(() => undefined);
});

const START = ["tu-do", "Kênh văn bản", "general", "Kênh thoại", "Alpha", "a1", "a2", "Beta", "b1", "Gamma"];

test("only a manager gets draggable rows and the grab cursor; the plain member's window has none", async () => {
  await expect(channel(member.page, "b1")).toBeVisible();
  expect(await member.page.locator("[draggable=true]").count()).toBe(0);
  expect(await channel(member.page, "b1").evaluate((el) => getComputedStyle(el).cursor)).not.toBe("grab");
  expect(await page.locator("[draggable=true]").count()).toBeGreaterThan(5);
  expect(await channel(page, "b1").evaluate((el) => getComputedStyle(el).cursor)).toBe("grab");
  await orderIs(page, START);
});

test("reorder two categories: Gamma goes above Alpha; the member follows live and the server agrees", async () => {
  await drag(header(page, "Gamma"), header(page, "Alpha"), "top");
  await orderIs(page, ["tu-do", "Kênh văn bản", "general", "Kênh thoại", "Gamma", "Alpha", "a1", "a2", "Beta", "b1"]);
  await orderIs(member.page, ["tu-do", "Kênh văn bản", "general", "Kênh thoại", "Gamma", "Alpha", "a1", "a2", "Beta", "b1"]);
  const g = await api<{ categories: { name: string; position: number }[] }>(A.token, "GET", `/guilds/${guildId}`);
  expect([...g.categories].sort((x, y) => x.position - y.position).map((c) => c.name)).toEqual(["Kênh văn bản", "Kênh thoại", "Gamma", "Alpha", "Beta"]);
});

test("a channel into an EMPTY category, then into another category's header (goes first), then within a category", async () => {
  await drag(channel(page, "b1"), header(page, "Gamma"));
  await orderIs(page, ["tu-do", "Kênh văn bản", "general", "Kênh thoại", "Gamma", "b1", "Alpha", "a1", "a2", "Beta"]);
  await orderIs(member.page, ["tu-do", "Kênh văn bản", "general", "Kênh thoại", "Gamma", "b1", "Alpha", "a1", "a2", "Beta"]);
  await drag(channel(page, "general"), header(page, "Alpha"));
  await orderIs(page, ["tu-do", "Kênh văn bản", "Kênh thoại", "Gamma", "b1", "Alpha", "general", "a1", "a2", "Beta"]);
  await drag(channel(page, "a2"), channel(page, "general"), "top"); // before general
  await orderIs(page, ["tu-do", "Kênh văn bản", "Kênh thoại", "Gamma", "b1", "Alpha", "a2", "general", "a1", "Beta"]);
  await drag(channel(page, "a2"), channel(page, "a1"), "bottom"); // after the last of the category
  await orderIs(page, ["tu-do", "Kênh văn bản", "Kênh thoại", "Gamma", "b1", "Alpha", "general", "a1", "a2", "Beta"]);
  await orderIs(member.page, ["tu-do", "Kênh văn bản", "Kênh thoại", "Gamma", "b1", "Alpha", "general", "a1", "a2", "Beta"]);
});

test("a COLLAPSED category stays a drop target: the channel lands first in it and it stays collapsed", async () => {
  await header(page, "Beta").click();
  await expect(header(page, "Beta")).toHaveAttribute("aria-expanded", "false");
  await drag(channel(page, "a2"), header(page, "Beta"));
  await expect(header(page, "Beta")).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => api<{ channels: { name: string; categoryId: string | null; position: number }[]; categories: { id: string; name: string }[] }>(A.token, "GET", `/guilds/${guildId}`).then((g) => {
    const beta = g.categories.find((c) => c.name === "Beta")!.id;
    return g.channels.filter((c) => c.categoryId === beta).sort((x, y) => x.position - y.position).map((c) => c.name);
  })).toEqual(["a2"]);
  await header(page, "Beta").click();
  await orderIs(page, ["tu-do", "Kênh văn bản", "Kênh thoại", "Gamma", "b1", "Alpha", "general", "a1", "Beta", "a2"]);
});

test("to the uncategorised area: after a loose row, and onto the dashed zone when that area is empty", async () => {
  await drag(channel(page, "a1"), channel(page, "tu-do"), "bottom");
  await orderIs(page, ["tu-do", "a1", "Kênh văn bản", "Kênh thoại", "Gamma", "b1", "Alpha", "general", "Beta", "a2"]);
  await orderIs(member.page, ["tu-do", "a1", "Kênh văn bản", "Kênh thoại", "Gamma", "b1", "Alpha", "general", "Beta", "a2"]);
  // empty the area (API), then drag by hand: the zone only exists while a channel is being dragged
  await api(A.token, "PUT", `/guilds/${guildId}/layout`, await layoutWith(["tu-do", "a1"], "Gamma"));
  await orderIs(page, ["Kênh văn bản", "Kênh thoại", "Gamma", "tu-do", "a1", "b1", "Alpha", "general", "Beta", "a2"]);
  const s = (await channel(page, "general").boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 4, s.y + s.height / 2 + 4, { steps: 3 });
  const zone = list(page).locator("> li.border-dashed");
  await expect(zone).toBeVisible();
  const z = (await zone.boundingBox())!;
  await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2, { steps: 8 });
  await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2 + 0.5);
  await expect(zone).toHaveAttribute("data-drop", "inside");
  await page.mouse.up();
  await orderIs(page, ["general", "Kênh văn bản", "Kênh thoại", "Gamma", "tu-do", "a1", "b1", "Alpha", "Beta", "a2"]);
});

/** The full layout body with `moved` channels sent to the START of the named category (test setup via the API). */
async function layoutWith(moved: string[], category: string) {
  const g = await api<{ channels: { id: string; name: string; categoryId: string | null; position: number }[]; categories: { id: string; name: string; position: number }[] }>(A.token, "GET", `/guilds/${guildId}`);
  const cats = [...g.categories].sort((x, y) => x.position - y.position);
  const target = cats.find((c) => c.name === category)!.id;
  const rest = [...g.channels].sort((x, y) => x.position - y.position);
  return {
    categories: cats.map((c) => c.id),
    channels: [...rest.filter((c) => moved.includes(c.name)).map((c) => ({ id: c.id, categoryId: target })), ...rest.filter((c) => !moved.includes(c.name)).map((c) => ({ id: c.id, categoryId: c.categoryId }))],
  };
}

test("files vs internal drags: a file over the column never reacts and an internal drag over the chat shows no upload overlay", async () => {
  await channel(page, "tu-do").click(); // open a chat to hold the overlay
  await expect(page.locator("main")).toBeVisible();
  let puts = 0;
  page.on("request", (r) => r.method() === "PUT" && r.url().includes("/layout") && puts++);
  const before = await names(page);

  // a FILE drag over the channel column: no drop indicator, no layout request, no overlay
  const hit = await channel(page, "b1").evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "f.png", { type: "image/png" }));
    for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientY: el.getBoundingClientRect().top + 2 }));
    return document.querySelectorAll("[data-drop]").length;
  });
  expect(hit).toBe(0);
  await expect(overlay(page)).toBeHidden();

  // an INTERNAL drag carried over the conversation: no overlay; dropping there changes nothing
  const s = (await channel(page, "b1").boundingBox())!;
  await page.mouse.move(s.x + 20, s.y + 10);
  await page.mouse.down();
  await page.mouse.move(s.x + 24, s.y + 14, { steps: 3 });
  const m = (await page.locator("main").boundingBox())!;
  await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2, { steps: 10 });
  await page.mouse.move(m.x + m.width / 2 + 1, m.y + m.height / 2 + 1);
  await expect(overlay(page)).toBeHidden();
  await page.mouse.up();
  expect(await names(page)).toEqual(before);
  expect(puts).toBe(0);

  // and a real file drag over the chat still shows the overlay (the R4 behaviour)
  await page.locator("main > div").first().evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "f.png", { type: "image/png" }));
    el.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(overlay(page)).toBeVisible();
  await page.locator("main > div").first().evaluate((el) => el.dispatchEvent(new DragEvent("drop", { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true })));
  page.removeAllListeners("request");
});

test("a click still opens a channel (a drag does not navigate); a failed PUT rolls the list back and toasts the 409", async () => {
  await channel(page, "a1").click();
  await expect(channel(page, "a1")).toHaveAttribute("aria-current", "page");

  const before = await names(page);
  await page.route("**/guilds/*/layout", (r) => (r.request().method() === "PUT" ? r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "Layout changed" }) }) : r.continue()));
  await drag(channel(page, "b1"), header(page, "Alpha"));
  await expect(page.getByText("Danh sách kênh vừa thay đổi ở nơi khác")).toBeVisible();
  await orderIs(page, before); // rolled back (and refetched)
  await expect(channel(page, "a1")).toHaveAttribute("aria-current", "page"); // the drag did not change the open channel
  await page.unroute("**/guilds/*/layout");
  await orderIs(member.page, before); // the member never saw the failed attempt
});
