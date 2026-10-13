import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { api, launchAs, resize, run, type Session } from "./helpers";

// Channel categories: create / fill / fold / rename / move / delete through the real UI, and a plain member's window
// following live (and offering no + or menus). Real dev server + docker.
let A: Session;
let B: Session; // plain member
let app: ElectronApplication;
let page: Page;
let member: { app: ElectronApplication; page: Page };
let guild: { id: string; name: string };
const userData = mkdtempSync(join(tmpdir(), "loop-e2e-cat-"));

const list = (p: Page) => p.getByRole("list", { name: "Danh sách kênh" });
const rail = (p: Page) => p.getByRole("navigation", { name: "Danh sách máy chủ" });
const header = (p: Page, name: string) => list(p).getByRole("button", { name, exact: true });
const channel = (p: Page, name: string) => list(p).getByRole("button", { name, exact: true });
const names = (p: Page) => list(p).getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent?.trim() ?? ""));
const server = async (p: Page, name: string) => {
  await p.getByRole("button", { name: /^Tuỳ chọn máy chủ/ }).click();
  await p.getByRole("button", { name, exact: true }).click();
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const reg = async (tag: string) => {
    const username = `${tag}_${run}`.toLowerCase();
    const r = await api<{ accessToken: string; user: Session["user"] }>(null, "POST", "/auth/register", { email: `${username}@example.com`, username, password: "correct-horse-battery" });
    return { token: r.accessToken, user: r.user };
  };
  [A, B] = await Promise.all([reg("cata"), reg("catb")]);
  const g = await api<{ guild: { id: string } }>(A.token, "POST", "/guilds", { name: `Danh mục ${run}` });
  guild = { id: g.guild.id, name: `Danh mục ${run}` };
  const { code } = await api<{ code: string }>(A.token, "POST", `/guilds/${guild.id}/invites`, {});
  await api(B.token, "POST", `/invites/${code}/join`);
  ({ app, page } = await launchAs(A));
  await resize(app, 1280, 800);
  member = await launchAs(B);
  await rail(page).getByRole("button", { name: guild.name }).click();
  await rail(member.page).getByRole("button", { name: guild.name }).click();
});
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await member?.app.close().catch(() => undefined);
});

test("a new server starts with the two default categories; a plain member sees them but no + and no menus", async () => {
  await expect(header(page, "Kênh văn bản")).toHaveAttribute("aria-expanded", "true");
  await expect(header(member.page, "Kênh thoại")).toBeVisible();
  await expect(channel(member.page, "general")).toBeVisible();
  await expect(member.page.getByRole("button", { name: /^Tạo kênh/ })).toHaveCount(0);
  await expect(member.page.getByRole("button", { name: /^Tuỳ chọn (danh mục|kênh)/ })).toHaveCount(0);
  await member.page.getByRole("button", { name: /^Tuỳ chọn máy chủ/ }).click();
  await expect(member.page.getByRole("button", { name: "Tạo danh mục" })).toHaveCount(0);
  await member.page.keyboard.press("Escape");
});

test("create a category (409 on a duplicate name), then a channel inside it; the member's window follows live", async () => {
  await page.getByRole("button", { name: /^Tuỳ chọn máy chủ/ }).click();
  await page.getByRole("button", { name: "Tạo danh mục", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Tạo danh mục" });
  await dialog.getByLabel("Tên danh mục").fill("Kênh văn bản");
  await dialog.getByRole("button", { name: "Tạo danh mục" }).click();
  await expect(dialog.getByText("Máy chủ đã có danh mục tên này. Chọn tên khác nhé.")).toBeVisible();
  await dialog.getByLabel("Tên danh mục").fill("Dự án");
  await dialog.getByRole("button", { name: "Tạo danh mục" }).click();
  await expect(dialog).toBeHidden();
  await expect(header(page, "Dự án")).toBeVisible();
  await expect(header(member.page, "Dự án")).toBeVisible();

  await page.getByRole("button", { name: "Tạo kênh trong Dự án" }).click();
  const create = page.getByRole("dialog", { name: "Tạo kênh" });
  await expect(create.getByText("Trong danh mục Dự án")).toBeVisible();
  await create.getByLabel("Tên kênh").fill("ke-hoach");
  await create.getByRole("button", { name: "Tạo kênh" }).click();
  await expect(create).toBeHidden();
  await expect.poll(() => names(page)).toEqual(expect.arrayContaining(["ke-hoach"]));
  const order = await names(page);
  expect(order.indexOf("ke-hoach")).toBeGreaterThan(order.indexOf("Dự án")); // it sits under its header, once
  expect(order.filter((n) => n === "ke-hoach")).toHaveLength(1);
  await expect(channel(member.page, "ke-hoach")).toBeVisible();
});

test("collapse keeps the open channel visible; the choice survives a reload of the list (per account)", async () => {
  await channel(page, "ke-hoach").click();
  await header(page, "Dự án").click();
  await expect(header(page, "Dự án")).toHaveAttribute("aria-expanded", "false");
  await expect(channel(page, "ke-hoach")).toBeVisible(); // the open channel stays
  await channel(page, "general").click();
  await expect(channel(page, "ke-hoach")).toHaveCount(0);
  await expect(header(member.page, "Dự án")).toHaveAttribute("aria-expanded", "true"); // the member's own state
  await page.reload();
  await expect(header(page, "Dự án")).toHaveAttribute("aria-expanded", "false");
  await header(page, "Dự án").click();
  await expect(channel(page, "ke-hoach")).toBeVisible();
});

test("rename a category (the server's 409 is shown), the member sees the new name", async () => {
  await page.getByRole("button", { name: "Tuỳ chọn danh mục Dự án" }).click();
  await page.getByRole("button", { name: "Đổi tên danh mục" }).click();
  const dialog = page.getByRole("dialog", { name: "Đổi tên danh mục" });
  await dialog.getByLabel("Tên danh mục").fill("Kênh thoại");
  await dialog.getByRole("button", { name: "Lưu" }).click();
  await expect(dialog.getByText("Máy chủ đã có danh mục tên này. Chọn tên khác nhé.")).toBeVisible();
  await dialog.getByLabel("Tên danh mục").fill("Công việc");
  await dialog.getByRole("button", { name: "Lưu" }).click();
  await expect(dialog).toBeHidden();
  await expect(header(page, "Công việc")).toBeVisible();
  await expect(header(member.page, "Công việc")).toBeVisible();
  await expect(header(member.page, "Dự án")).toHaveCount(0);
});

test("move a channel through the menu, and reorder with Lên / Xuống", async () => {
  await page.getByRole("button", { name: "Tuỳ chọn kênh general" }).click();
  await page.getByRole("button", { name: "Chuyển vào danh mục" }).click();
  const dialog = page.getByRole("dialog", { name: "Chuyển general vào danh mục" });
  await dialog.getByRole("button", { name: "Công việc" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const n = await names(page);
    return n.indexOf("general") > n.indexOf("Công việc");
  }).toBe(true);
  await expect.poll(async () => {
    const n = await names(member.page);
    return n.indexOf("general") > n.indexOf("Công việc");
  }).toBe(true);

  // within "Công việc": ke-hoach, general -> general goes up
  await page.getByRole("button", { name: "Tuỳ chọn kênh general" }).click();
  await page.getByRole("button", { name: "Lên", exact: true }).click();
  await expect.poll(async () => {
    const n = await names(page);
    return n.indexOf("general") < n.indexOf("ke-hoach");
  }).toBe(true);
  await expect.poll(async () => {
    const n = await names(member.page);
    return n.indexOf("general") < n.indexOf("ke-hoach");
  }).toBe(true);

  // a category moves too: from last to above "Kênh thoại"
  await page.getByRole("button", { name: "Tuỳ chọn danh mục Công việc" }).click();
  await page.getByRole("button", { name: "Đưa danh mục lên", exact: true }).click();
  await expect.poll(async () => {
    const n = await names(page);
    return n.indexOf("Công việc") < n.indexOf("Kênh thoại") && n.indexOf("Kênh văn bản") < n.indexOf("Công việc");
  }).toBe(true);
});

test("deleting a category keeps its channels (they become uncategorised) for both windows", async () => {
  await page.getByRole("button", { name: "Tuỳ chọn danh mục Công việc" }).click();
  await page.getByRole("button", { name: "Xoá danh mục", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Xoá danh mục Công việc?" });
  await expect(dialog.getByText(/không bị xoá/)).toBeVisible();
  await dialog.getByRole("button", { name: "Xoá danh mục" }).click();
  await expect(dialog).toBeHidden();
  for (const p of [page, member.page]) {
    await expect(header(p, "Công việc")).toHaveCount(0);
    await expect(channel(p, "ke-hoach")).toBeVisible();
    await expect(channel(p, "general")).toBeVisible();
    const n = await names(p);
    expect(n.indexOf("general")).toBeLessThan(n.indexOf("Kênh văn bản")); // uncategorised comes first, no header
  }
});

test("the server menu's Tạo kênh makes an uncategorised channel", async () => {
  await server(page, "Tạo kênh");
  const create = page.getByRole("dialog", { name: "Tạo kênh" });
  await expect(create.getByText(/Trong danh mục/)).toHaveCount(0);
  await create.getByLabel("Tên kênh").fill("tu-do");
  await create.getByRole("button", { name: "Tạo kênh" }).click();
  await expect(create).toBeHidden();
  const n = await names(page);
  expect(n.indexOf("tu-do")).toBeLessThan(n.indexOf("Kênh văn bản"));
});
