import { Permission } from "@loop/shared";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { api, expectEllipsis, expectNoHorizontalOverflow, launchAs, register, resize, run, status, type Session } from "./helpers";

// 9e: server administration against the REAL dev server + docker. Everyone but A (the app's user) is an API script.
// Every server is created BEFORE the window opens so the rail already lists it.
type Role = { id: string; name: string; permissions: number; position: number };
type Member = { userId: string; roleIds: string[] };
type Guild = { id: string; name: string; general: string };

let app: ElectronApplication;
let page: Page;
let A: Session;
const owned: { owner: Session; guild: Guild }[] = []; // cleaned up at the end where cheap

async function newGuild(owner: Session, tag: string): Promise<Guild> {
  const name = `${tag}_${run}`;
  const r = await api<{ guild: { id: string }; channels: { id: string }[] }>(owner.token, "POST", "/guilds", { name });
  const guild = { id: r.guild.id, name, general: r.channels[0].id };
  owned.push({ owner, guild });
  return guild;
}
async function join(owner: Session, guild: Guild, ...users: Session[]) {
  const { code } = await api<{ code: string }>(owner.token, "POST", `/guilds/${guild.id}/invites`, {});
  for (const u of users) await api(u.token, "POST", `/invites/${code}/join`);
}
const mkRole = (owner: Session, g: Guild, name: string, permissions: number) => api<Role>(owner.token, "POST", `/guilds/${g.id}/roles`, { name, permissions });
const assign = (owner: Session, g: Guild, u: Session, r: Role) => api(owner.token, "PUT", `/guilds/${g.id}/members/${u.user.id}/roles/${r.id}`);
const rolesOf = (s: Session, g: Guild) => api<Role[]>(s.token, "GET", `/guilds/${g.id}/roles`);
const membersOf = (s: Session, g: Guild) => api<Member[]>(s.token, "GET", `/guilds/${g.id}/members`);

const rail = () => page.getByRole("navigation", { name: "Danh sách máy chủ" });
const openServer = async (g: Guild) => {
  await rail().getByRole("button", { name: g.name }).click();
  await expect(page.getByRole("button", { name: `Tuỳ chọn máy chủ ${g.name}` })).toBeVisible();
};
const settingsEntry = () => page.getByRole("button", { name: "Cài đặt máy chủ", exact: true });
const openSettings = async (g: Guild, tab: string) => {
  await openServer(g);
  await page.getByRole("button", { name: `Tuỳ chọn máy chủ ${g.name}` }).click();
  await settingsEntry().click();
  await page.getByRole("tab", { name: tab }).click();
  await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
};
const closeSettings = () => page.getByRole("button", { name: "Đóng cài đặt" }).click();
const panel = () => page.locator("#settings-panel");
const perm = (label: string) => page.getByRole("checkbox", { name: new RegExp(`^${label}`) });
const memberRow = (s: Session) => panel().getByRole("listitem").filter({ has: page.getByText(s.user.username, { exact: true }) }).first();
const rowMenu = async (s: Session, item: string) => {
  await memberRow(s).getByRole("button", { name: `Thao tác với ${s.user.username}` }).click();
  await page.getByRole("button", { name: item, exact: true }).click();
};

test.describe.configure({ mode: "serial" });

let S1: Guild, S2: Guild, S3: Guild, S4: Guild, S5: Guild, S6: Guild, S7: Guild;
let B: Session, C: Session, D: Session, E: Session;
let S5above: Role, S5lead: Role, S5below: Role, S5heavy: Role;
const crowd: Session[] = [];
const longRole = `${"R".repeat(90)}_${run}`;

test.beforeAll(async () => {
  A = await register("xa");
  [B, C, D, E] = await Promise.all([register("xb"), register("xc"), register("xd"), register("xe")]);
  S1 = await newGuild(A, "adm1");
  await join(A, S1, B, C);
  S2 = await newGuild(A, "adm2");
  await join(A, S2, B, E);
  await api(A.token, "POST", `/guilds/${S2.id}/channels`, { name: "extra", type: "TEXT" });
  S3 = await newGuild(A, "adm3");
  await join(A, S3, B);
  S4 = await newGuild(A, "adm4");

  // S5: B owns it; A holds "lead" (MANAGE_ROLES + MANAGE_MESSAGES); creation order puts heavy < below < lead < above
  S5 = await newGuild(B, "adm5");
  await join(B, S5, A, C, D);
  S5above = await mkRole(B, S5, `above_${run}`, Permission.MANAGE_MESSAGES);
  S5lead = await mkRole(B, S5, `lead_${run}`, Permission.MANAGE_ROLES | Permission.MANAGE_MESSAGES);
  S5below = await mkRole(B, S5, `below_${run}`, Permission.MANAGE_MESSAGES);
  S5heavy = await mkRole(B, S5, `heavy_${run}`, Permission.KICK_MEMBERS);
  await assign(B, S5, A, S5lead);
  await assign(B, S5, C, S5above); // C is above A
  S6 = await newGuild(B, "adm6"); // A is a plain member
  await join(B, S6, A);

  // S7: A owns it, with 40 roles and 60 members
  S7 = await newGuild(A, "adm7");
  const long = await mkRole(A, S7, longRole, Permission.MANAGE_MESSAGES);
  for (let i = 1; i < 40; i++) await mkRole(A, S7, `vai_tro_${i}_${run}`, 0);
  const users = await Promise.all(Array.from({ length: 60 }, (_, i) => register(`xm${i}`)));
  crowd.push(...users);
  const { code } = await api<{ code: string }>(A.token, "POST", `/guilds/${S7.id}/invites`, {});
  for (let i = 0; i < users.length; i += 10) await Promise.all(users.slice(i, i + 10).map((u) => api(u.token, "POST", `/invites/${code}/join`)));
  await assign(A, S7, users[0], long);

  ({ app, page } = await launchAs(A));
});
test.afterAll(async () => {
  for (const { owner, guild } of owned) await status(owner.token, "DELETE", `/guilds/${guild.id}`).catch(() => 0);
  await app?.close();
});

test("a plain member never sees the settings entry nor channel menus", async () => {
  await openServer(S6);
  await page.getByRole("button", { name: `Tuỳ chọn máy chủ ${S6.name}` }).click();
  await expect(page.getByRole("button", { name: "Rời máy chủ" })).toBeVisible();
  await expect(settingsEntry()).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^Tuỳ chọn kênh/ })).toHaveCount(0);
});

test("owner: create a role with MANAGE_MESSAGES, assign it, B can delete another's message, edit sends only the diff, remove, delete", async () => {
  const patches: unknown[] = [];
  page.on("request", (r) => r.method() === "PATCH" && r.url().includes("/roles/") && patches.push(JSON.parse(r.postData() ?? "{}")));
  const roleName = `mod_${run}`;
  await openSettings(S1, "Vai trò");
  await page.getByRole("button", { name: "Tạo vai trò" }).click();
  await page.getByLabel("Tên vai trò").fill(roleName);
  await perm("Quản lý tin nhắn").check();
  await page.getByRole("button", { name: "Tạo vai trò" }).last().click();
  await expect(page.getByRole("list", { name: "Danh sách vai trò" }).getByText(roleName)).toBeVisible();
  const mod = (await rolesOf(A, S1)).find((r) => r.name === roleName)!;
  expect(mod.permissions).toBe(Permission.MANAGE_MESSAGES);

  await page.getByRole("tab", { name: "Thành viên" }).click();
  await rowMenu(B, "Gán vai trò");
  const dialog = page.getByRole("dialog", { name: `Vai trò của ${B.user.username}` });
  await dialog.getByRole("checkbox", { name: roleName }).click(); // applied on the server, shown after the refetch
  await expect.poll(async () => (await membersOf(A, S1)).find((m) => m.userId === B.user.id)!.roleIds).toEqual([mod.id]);
  await dialog.getByRole("button", { name: "Đóng" }).click();
  await expect(memberRow(B).getByText(roleName)).toBeVisible();

  const msg = await api<{ id: string }>(C.token, "POST", `/channels/${S1.general}/messages`, { content: "xoá tôi" });
  await api(B.token, "DELETE", `/messages/${msg.id}`); // B holds MANAGE_MESSAGES through the role: 204

  await page.getByRole("tab", { name: "Vai trò" }).click();
  await page.getByRole("list", { name: "Danh sách vai trò" }).getByText(roleName).click();
  await perm("Quản lý kênh").check();
  await page.getByRole("button", { name: "Lưu thay đổi" }).click();
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  expect(patches).toEqual([{ permissions: Permission.MANAGE_MESSAGES | Permission.MANAGE_CHANNELS }]); // no name, nothing unchanged
  expect((await rolesOf(A, S1)).find((r) => r.id === mod.id)!.permissions).toBe(Permission.MANAGE_MESSAGES | Permission.MANAGE_CHANNELS);
  await expect(page.getByRole("button", { name: "Lưu thay đổi" })).toBeDisabled(); // nothing left to save

  await page.getByRole("button", { name: "Danh sách vai trò" }).click();
  await page.getByRole("tab", { name: "Thành viên" }).click();
  await rowMenu(B, "Gán vai trò");
  await dialog.getByRole("checkbox", { name: roleName }).click();
  await expect.poll(async () => (await membersOf(A, S1)).find((m) => m.userId === B.user.id)!.roleIds).toEqual([]);
  await dialog.getByRole("button", { name: "Đóng" }).click();
  const msg2 = await api<{ id: string }>(C.token, "POST", `/channels/${S1.general}/messages`, { content: "giữ tôi" });
  expect(await status(B.token, "DELETE", `/messages/${msg2.id}`)).toBe(403);

  await page.getByRole("tab", { name: "Vai trò" }).click();
  await page.getByRole("list", { name: "Danh sách vai trò" }).getByText(roleName).click();
  await page.getByRole("button", { name: "Xoá vai trò" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Xoá vai trò" }).click();
  await expect(page.getByRole("list", { name: "Danh sách vai trò" })).toBeVisible();
  await expect.poll(async () => (await rolesOf(A, S1)).some((r) => r.id === mod.id)).toBe(false);
  expect((await rolesOf(A, S1)).map((r) => r.name)).toEqual(["@everyone"]);
});

test("kick: confirm, then the member is gone", async () => {
  await page.getByRole("tab", { name: "Thành viên" }).click();
  await rowMenu(C, "Đuổi khỏi máy chủ");
  await page.getByRole("dialog", { name: `Đuổi ${C.user.username}?` }).getByRole("button", { name: "Đuổi khỏi máy chủ" }).click();
  await expect(memberRow(C)).toHaveCount(0);
  expect((await membersOf(A, S1)).some((m) => m.userId === C.user.id)).toBe(false);
  await closeSettings();
});

test("channel overwrite via the channel menu: deny VIEW for @everyone, allow for a role; preview matches the server; reset deletes", async () => {
  const vip = await mkRole(A, S2, `vip_${run}`, 0);
  await assign(A, S2, E, vip);
  await openServer(S2);
  await page.getByRole("button", { name: "Tuỳ chọn kênh general" }).click();
  await page.getByRole("button", { name: "Quyền của kênh" }).click();
  await expect(page.getByRole("tab", { name: "Quyền theo kênh" })).toHaveAttribute("aria-selected", "true");
  await expect(panel().getByLabel("Kênh", { exact: true })).toHaveValue(S2.general);

  const view = () => page.getByRole("radiogroup", { name: /^Xem kênh/ });
  const previewView = () => panel().locator('[data-bit="VIEW_CHANNEL"]');
  await panel().getByLabel("Vai trò", { exact: true }).selectOption({ label: "@everyone" });
  await expect(previewView()).toHaveAttribute("data-allowed", "true");
  await view().getByText("Từ chối", { exact: true }).click();
  await expect(previewView()).toHaveAttribute("data-allowed", "false"); // the live preview, before saving
  await panel().getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  expect(await status(B.token, "GET", `/channels/${S2.general}`)).toBe(404);

  await panel().getByLabel("Vai trò", { exact: true }).selectOption({ label: `vip_${run}` });
  await view().getByText("Cho phép", { exact: true }).click();
  await expect(previewView()).toHaveAttribute("data-allowed", "true");
  await panel().getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  expect(await status(E.token, "GET", `/channels/${S2.general}/messages`)).toBe(200); // the role sees it, preview said so
  expect(await status(B.token, "GET", `/channels/${S2.general}/messages`)).toBe(404); // B (no role) does not

  await panel().getByLabel("Vai trò", { exact: true }).selectOption({ label: "@everyone" });
  await expect(view().getByLabel("Từ chối")).toBeChecked(); // loaded from GET /guilds/:id
  await page.getByRole("button", { name: "Đặt tất cả về Mặc định" }).click();
  await panel().getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  expect(await status(B.token, "GET", `/channels/${S2.general}/messages`)).toBe(200);
  const ch = await api<{ channels: { id: string; overwrites: { roleId: string }[] }[] }>(A.token, "GET", `/guilds/${S2.id}`);
  expect(ch.channels.find((c) => c.id === S2.general)!.overwrites.map((o) => o.roleId)).toEqual([vip.id]); // the @everyone one is gone
  await closeSettings();
});

test("channel menu deletes a channel; the last one is protected with a Vietnamese explanation", async () => {
  await openServer(S2);
  await page.getByRole("button", { name: "Tuỳ chọn kênh extra" }).click();
  await page.getByRole("button", { name: "Xoá kênh" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Xoá kênh" }).click();
  await expect(page.getByRole("button", { name: "extra", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Tuỳ chọn kênh general" }).click();
  await page.getByRole("button", { name: "Xoá kênh" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Xoá kênh" }).click();
  await expect(page.getByRole("dialog").getByText("Máy chủ phải giữ lại ít nhất một kênh.")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Huỷ" }).click();
});

test("non-owner with MANAGE_ROLES: read-only above its top, ungrantable bits disabled, forced attempt gets the Vietnamese 403, assign list hides what it cannot hand out", async () => {
  await openSettings(S5, "Vai trò");
  await expect(page.getByRole("tab", { name: "Nguy hiểm" })).toHaveCount(0);
  const list = page.getByRole("list", { name: "Danh sách vai trò" });
  for (const r of [S5above, S5lead]) await expect(list.getByRole("listitem").filter({ hasText: r.name }).getByText("Chỉ xem")).toHaveCount(1);
  for (const r of [S5below, S5heavy]) await expect(list.getByRole("listitem").filter({ hasText: r.name }).getByText("Chỉ xem")).toHaveCount(0);

  await list.getByText(S5above.name).click(); // at/above the top: nothing can be edited
  await expect(page.getByLabel("Tên vai trò")).toBeDisabled();
  await expect(perm("Nhắn tin")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Lưu thay đổi" })).toHaveCount(0);
  await page.getByRole("button", { name: "Danh sách vai trò" }).click();

  await list.getByText(S5below.name).click();
  await expect(perm("Quản lý tin nhắn")).toBeEnabled(); // held
  await expect(perm("Đuổi thành viên")).toBeDisabled(); // not held
  await expect(perm("Quản trị viên")).toBeDisabled();
  await expect(perm("Quản lý kênh")).toBeDisabled();
  await perm("Đuổi thành viên").evaluate((el: HTMLInputElement) => (el.disabled = false)); // force it past the UI
  await perm("Đuổi thành viên").check();
  await page.getByRole("button", { name: "Lưu thay đổi" }).click();
  await expect(page.getByRole("alert").or(page.locator("[aria-live=polite]").getByText("Bạn không thể cấp hoặc gỡ quyền mà chính bạn không có."))).toBeVisible();
  expect((await rolesOf(B, S5)).find((r) => r.id === S5below.id)!.permissions).toBe(Permission.MANAGE_MESSAGES);
  await page.getByRole("button", { name: "Danh sách vai trò" }).click();

  await page.getByRole("tab", { name: "Thành viên" }).click();
  await expect(memberRow(B).getByRole("button", { name: /^Thao tác/ })).toHaveCount(0); // the owner
  await expect(memberRow(C).getByRole("button", { name: /^Thao tác/ })).toHaveCount(0); // holds "above"
  await rowMenu(D, "Gán vai trò"); // D is plain: reachable, but no kick for A (no KICK_MEMBERS)
  await expect(page.getByRole("button", { name: "Đuổi khỏi máy chủ" })).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: `Vai trò của ${D.user.username}` });
  await expect(dialog.getByRole("checkbox", { name: S5below.name })).toBeEnabled();
  await expect(dialog.getByRole("checkbox", { name: S5heavy.name })).toHaveCount(0); // carries KICK_MEMBERS, which A lacks (rule 2b)
  await expect(dialog.getByRole("checkbox", { name: S5lead.name })).toHaveCount(0); // equal to A's top
  await expect(dialog.getByRole("checkbox", { name: S5above.name })).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: S5below.name }).click();
  await expect.poll(async () => (await membersOf(B, S5)).find((m) => m.userId === D.user.id)!.roleIds).toEqual([S5below.id]);
  // a forced hierarchy attempt straight at the server gets the same refusal the UI maps
  expect(await status(A.token, "PUT", `/guilds/${S5.id}/members/${D.user.id}/roles/${S5above.id}`)).toBe(403);
  await dialog.getByRole("button", { name: "Đóng" }).click();
  await closeSettings();
});

test("transfer ownership: the app user becomes a normal member and the owner-only section is gone", async () => {
  await openSettings(S3, "Nguy hiểm");
  await page.getByLabel("Chuyển cho").selectOption({ label: B.user.username });
  await panel().getByRole("button", { name: "Chuyển quyền chủ sở hữu" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Chuyển quyền chủ sở hữu" }).click();
  // A keeps no admin right in S3 any more, so the view closes and the menu loses its entry
  await expect(page.getByRole("tab", { name: "Nguy hiểm" })).toHaveCount(0);
  await expect(page.getByRole("tablist")).toHaveCount(0);
  const g = await api<{ guild: { ownerId: string } }>(A.token, "GET", `/guilds/${S3.id}`);
  expect(g.guild.ownerId).toBe(B.user.id);
  await page.getByRole("button", { name: `Tuỳ chọn máy chủ ${S3.name}` }).click();
  await expect(settingsEntry()).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(await status(A.token, "DELETE", `/guilds/${S3.id}`)).toBe(403);
  expect(await status(B.token, "DELETE", `/guilds/${S3.id}`)).toBe(204); // the new owner can
});

test("delete server needs the exact name typed; success goes Home", async () => {
  await openSettings(S4, "Nguy hiểm");
  await panel().getByRole("button", { name: "Xoá máy chủ" }).click();
  const dialog = page.getByRole("dialog", { name: `Xoá ${S4.name}?` });
  const confirm = dialog.getByRole("button", { name: "Xoá máy chủ" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Tên máy chủ").fill(S4.name.slice(0, -1));
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Tên máy chủ").fill(S4.name);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByRole("button", { name: "Trang chủ" })).toHaveAttribute("aria-current", "page");
  await expect(rail().getByRole("button", { name: S4.name })).toHaveCount(0);
  expect(await status(A.token, "GET", `/guilds/${S4.id}`)).toBe(404);
});

test("layout with 40 roles and 60 members: no horizontal overflow at 1280x800 and 960x600, ellipsis, lists scroll", async () => {
  for (const [w, h] of [[1280, 800], [960, 600]] as const) {
    await resize(app, w, h);
    await openSettings(S7, "Vai trò");
    await expect(page.getByRole("list", { name: "Danh sách vai trò" }).getByRole("listitem")).toHaveCount(41);
    await expectNoHorizontalOverflow([panel(), page.locator("main")]);
    await expectEllipsis(page.getByRole("list", { name: "Danh sách vai trò" }).getByText(longRole));
    expect(await panel().evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    await page.getByRole("tab", { name: "Thành viên" }).click();
    await expect(page.getByRole("list", { name: "Thành viên của máy chủ" }).locator(":scope > li")).toHaveCount(61);
    await expectNoHorizontalOverflow([panel(), page.locator("main")]);
    await expectEllipsis(panel().locator("li[title]").filter({ hasText: "RRRR" }).first());
    expect(await panel().evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    await page.getByRole("tab", { name: "Quyền theo kênh" }).click();
    await expect(panel().getByLabel("Kênh", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow([panel(), page.locator("main")]);
    await closeSettings();
  }
  await resize(app, 1280, 800);
});

test("a restored settings view is re-checked: reopening after losing the right shows no settings", async () => {
  // A is only a plain member of S6; force the persisted place to a settings tab, then reload the window
  const userId = A.user.id;
  await openServer(S6);
  await page.evaluate(([id, guildId]) => localStorage.setItem(`loop.lastPlace.${id}`, JSON.stringify({ guildId, channelId: null, dmId: null, settings: "roles" })), [userId, S6.id]);
  await page.reload();
  await expect(page.getByRole("button", { name: `Tuỳ chọn máy chủ ${S6.name}` })).toBeVisible(); // the place itself was restored
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^Cài đặt:/ })).toHaveCount(0);
});
