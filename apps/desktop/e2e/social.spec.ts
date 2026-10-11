import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { api, befriend, connect, expectEllipsis, expectNoHorizontalOverflow, launchAs, networkSwitch, register, resize, run, status, type Conn, type Session } from "./helpers";

// 9c: friends, DMs, blocks and presence against the REAL dev server + docker. Everyone but A is a script.
let app: ElectronApplication;
let page: Page;
let A: Session;
let B: Session;
let bConn: Conn;
const created: Session[] = [];

const tab = (name: RegExp | string) => page.getByRole("tab", { name });
const addInput = () => page.getByLabel("Thêm bạn bằng tên người dùng");
const addError = () => page.locator("form[aria-label='Thêm bạn'] p[aria-live='polite']");
const friendRows = () => page.getByRole("list", { name: "Danh sách bạn bè" }).getByRole("listitem");
const dmList = () => page.getByRole("list", { name: "Danh sách tin nhắn trực tiếp" });
const dmButton = (s: Session) => dmList().getByRole("button", { name: new RegExp(s.user.username) });
const log = () => page.getByRole("log");
const composer = () => page.getByRole("textbox", { name: /^Nhắn cho / });
const messageText = (text: string) => log().getByText(text, { exact: true });
const goFriends = () => dmList().getByRole("button", { name: "Bạn bè" }).click();
const addFriend = async (username: string) => {
  await addInput().fill(username);
  await addInput().press("Enter");
};
const newUser = async (tag: string) => {
  const s = await register(tag);
  created.push(s);
  return s;
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  A = await register("sa");
  B = await register("sb");
  bConn = await connect(B);
  ({ app, page } = await launchAs(A));
});
test.afterAll(async () => {
  bConn?.close();
  await app?.close();
});

test("Friends is Home's first screen; adding validates, and an unknown name and a blocked one get the SAME message", async () => {
  await expect(page.getByRole("button", { name: "Trang chủ" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Chưa có bạn bè")).toBeVisible();
  await addInput().press("Enter");
  await expect(addError()).toHaveText("Vui lòng điền mục này.");
  await addFriend("Ab!");
  await expect(addError()).toHaveText("Chỉ dùng chữ thường không dấu, số, dấu _ và dấu chấm.");
  await addFriend("x");
  await expect(addError()).toHaveText("Tên người dùng cần ít nhất 2 ký tự.");

  const requests: string[] = [];
  page.on("request", (r) => r.url().includes("/friends/requests") && requests.push(r.method()));
  await addFriend(`khong_ton_tai_${run}`);
  await expect(addError()).toContainText("Không tìm thấy người dùng này");
  const unknownText = await addError().innerText();

  const C = await newUser("sc");
  await api(C.token, "PUT", `/blocks/${A.user.id}`);
  await addFriend(C.user.username);
  await expect(addError()).toHaveText(unknownText); // a block must not be distinguishable
  expect(unknownText).not.toMatch(/chặn/i);

  await addFriend(A.user.username);
  await expect(addError()).toHaveText("Bạn không thể tự kết bạn với chính mình.");
  expect(requests).toEqual(["POST", "POST", "POST"]); // client-side validation stopped the first three
});

test("A -> B: the request is outgoing; B accepts and the friend appears live, online", async () => {
  await addFriend(B.user.username.toUpperCase()); // typed in capitals: the form lower-cases it
  await expect(page.getByRole("status").filter({ hasText: "Đã gửi lời mời kết bạn" })).toHaveText(`Đã gửi lời mời kết bạn tới ${B.user.username}.`);
  await expect(addInput()).toHaveValue("");
  await addFriend(B.user.username);
  await expect(addError()).toHaveText("Hai bạn đã là bạn bè hoặc lời mời đang chờ.");

  await tab(/^Đang chờ/).click();
  const sent = page.getByRole("region", { name: /^Đã gửi/ }).or(page.locator("section").filter({ hasText: "Đã gửi (1)" }));
  await expect(sent.getByText(B.user.username)).toBeVisible();
  await expect(sent.getByRole("button", { name: "Huỷ lời mời" })).toBeVisible();

  await api(B.token, "POST", `/friends/requests/${A.user.id}/accept`); // no reload anywhere in this test
  await expect(tab(/^Đang chờ/)).toHaveText("Đang chờ (0)");
  await tab(/^Tất cả/).click();
  await expect(friendRows()).toHaveCount(1);
  await expect(friendRows().first()).toContainText(B.user.username);
  await expect(friendRows().first()).toContainText("Đang hoạt động"); // B's socket is connected
});

test("tabs: arrow keys, Home and End move between tabs and select them", async () => {
  await tab(/^Tất cả/).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(/^Đang chờ/)).toHaveAttribute("aria-selected", "true");
  await expect(tab(/^Đang chờ/)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tab(/^Đã chặn/)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight"); // wraps
  await expect(tab(/^Tất cả/)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tab(/^Đã chặn/)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tab(/^Tất cả/)).toBeFocused();
  // only the selected tab is in the Tab order
  await expect(tab(/^Đang chờ/)).toHaveAttribute("tabindex", "-1");
});

test("an incoming request appears live; accept, decline and cancel work", async () => {
  const E = await newUser("se");
  const F = await newUser("sf");
  const G = await newUser("sg");
  const eConn = await connect(E);
  await tab(/^Đang chờ/).click();

  await api(E.token, "POST", "/friends/requests", { username: A.user.username });
  const incoming = page.locator("section").filter({ hasText: "Lời mời đến" });
  await expect(incoming.getByText(E.user.username)).toBeVisible();
  await expect(tab(/^Đang chờ/)).toHaveText("Đang chờ (1)");
  await incoming.getByRole("button", { name: "Chấp nhận" }).click();
  await eConn.waitFor("friend:accepted", (d) => d.user.id === A.user.id);
  await tab(/^Tất cả/).click();
  await expect(friendRows().filter({ hasText: E.user.username })).toHaveCount(1);

  await api(F.token, "POST", "/friends/requests", { username: A.user.username });
  await tab(/^Đang chờ/).click();
  await expect(incoming.getByText(F.user.username)).toBeVisible();
  await incoming.getByRole("button", { name: "Từ chối" }).click();
  await expect(incoming).toHaveCount(0);
  expect((await api<{ outgoing: unknown[] }>(F.token, "GET", "/friends")).outgoing).toEqual([]);

  await addFriend(G.user.username);
  const outgoing = page.locator("section").filter({ hasText: "Đã gửi (1)" });
  await expect(outgoing.getByText(G.user.username)).toBeVisible();
  await outgoing.getByRole("button", { name: "Huỷ lời mời" }).click();
  await expect(outgoing).toHaveCount(0);
  expect((await api<{ incoming: unknown[] }>(G.token, "GET", "/friends")).incoming).toEqual([]);

  // unfriend through the popover menu with a confirm dialog: E is told
  await tab(/^Tất cả/).click();
  await friendRows().filter({ hasText: E.user.username }).getByRole("button", { name: `Tuỳ chọn cho ${E.user.username}` }).click();
  await page.getByRole("button", { name: "Huỷ kết bạn" }).click();
  const dialog = page.getByRole("dialog", { name: `Huỷ kết bạn với ${E.user.username}?` });
  await expect(dialog.getByRole("button", { name: "Huỷ", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Huỷ kết bạn" }).click();
  await expect(friendRows().filter({ hasText: E.user.username })).toHaveCount(0);
  await eConn.waitFor("friend:removed", (d) => d.userId === A.user.id);
  eConn.close();
});

test("B removes the friendship: the row goes at once; B adds A back: the friend returns live", async () => {
  await api(B.token, "DELETE", `/friends/${A.user.id}`);
  await expect(friendRows().filter({ hasText: B.user.username })).toHaveCount(0);
  await api(B.token, "POST", "/friends/requests", { username: A.user.username });
  await tab(/^Đang chờ/).click();
  await page.locator("section").filter({ hasText: "Lời mời đến" }).getByRole("button", { name: "Chấp nhận" }).click();
  await tab(/^Tất cả/).click();
  await expect(friendRows().filter({ hasText: B.user.username })).toHaveCount(1);
});

let dmId = "";
test("DM: open from the friends list; messages both ways live; edit and delete are author-only", async () => {
  await friendRows().filter({ hasText: B.user.username }).getByRole("button", { name: `Nhắn tin với ${B.user.username}` }).click();
  await expect(page.getByRole("heading", { name: B.user.username })).toBeVisible();
  await expect(page.getByText("Đang hoạt động").first()).toBeVisible();
  await expect(dmButton(B)).toHaveAttribute("aria-current", "page");
  await expect(log().getByText(`Đây là khởi đầu cuộc trò chuyện với ${B.user.username}`)).toBeVisible();
  dmId = (await api<{ id: string }>(B.token, "POST", "/dms", { userId: A.user.id })).id;

  const fromB = await api<{ id: string }>(B.token, "POST", `/dms/${dmId}/messages`, { content: "Chào A từ B" });
  await expect(messageText("Chào A từ B")).toBeVisible();

  bConn.events.length = 0;
  await composer().fill("Chào B, A đây");
  await composer().press("Enter");
  await expect(messageText("Chào B, A đây")).toHaveCount(1);
  await bConn.waitFor("dm:message:new", (d) => d.content === "Chào B, A đây");
  const mine = log().getByRole("article").filter({ hasText: "Chào B, A đây" });
  await mine.hover();
  await mine.getByRole("button", { name: "Sửa tin nhắn" }).click();
  await page.getByRole("textbox", { name: "Sửa tin nhắn" }).fill("Chào B, đã sửa");
  await page.getByRole("textbox", { name: "Sửa tin nhắn" }).press("Enter");
  await bConn.waitFor("dm:message:update", (d) => d.content === "Chào B, đã sửa");
  const edited = log().getByRole("article").filter({ hasText: "Chào B, đã sửa" });
  await expect(edited.getByText("(đã chỉnh sửa)")).toBeVisible();
  await edited.hover();
  await edited.getByRole("button", { name: "Xoá tin nhắn" }).click();
  await page.getByRole("dialog", { name: "Xoá tin nhắn?" }).getByRole("button", { name: "Xoá", exact: true }).click();
  await expect(messageText("Chào B, đã sửa")).toHaveCount(0);
  await bConn.waitFor("dm:message:delete");

  // B's own edit and delete reach A; A (no moderators in a DM) gets neither button on B's message
  const theirs = log().getByRole("article").filter({ hasText: "Chào A từ B" });
  await theirs.hover();
  await expect(theirs.getByRole("button", { name: "Sửa tin nhắn" })).toHaveCount(0);
  await expect(theirs.getByRole("button", { name: "Xoá tin nhắn" })).toHaveCount(0);
  await api(B.token, "PATCH", `/messages/${fromB.id}`, { content: "B đã sửa tin" });
  await expect(messageText("B đã sửa tin")).toBeVisible();
  const second = await api<{ id: string }>(B.token, "POST", `/dms/${dmId}/messages`, { content: "Tin sẽ bị B xoá" });
  await expect(messageText("Tin sẽ bị B xoá")).toBeVisible();
  await api(B.token, "DELETE", `/messages/${second.id}`);
  await expect(messageText("Tin sẽ bị B xoá")).toHaveCount(0);
});

test("DM list is ordered by last activity", async () => {
  const D = await newUser("sd");
  await befriend(A, D);
  await goFriends();
  await friendRows().filter({ hasText: D.user.username }).getByRole("button", { name: `Nhắn tin với ${D.user.username}` }).click();
  await expect(dmButton(D)).toHaveAttribute("aria-current", "page");
  const order = async () => (await dmList().getByRole("button").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
  await expect.poll(async () => (await order()).findIndex((t) => t.includes(D.user.username))).toBeLessThan(2); // D is new: top
  const dDm = (await api<{ id: string }[]>(D.token, "GET", "/dms")).find(() => true)!.id;
  await api(B.token, "POST", `/dms/${dmId}/messages`, { content: "B nhắn khi A đang xem DM khác" });
  await expect.poll(async () => (await order()).findIndex((t) => t.includes(B.user.username))).toBe(1); // [Bạn bè, B, D]
  await api(D.token, "POST", `/dms/${dDm}/messages`, { content: "D nhắn sau" });
  await expect.poll(async () => (await order()).findIndex((t) => t.includes(D.user.username))).toBe(1);
  await dmButton(B).click();
  await expect(messageText("B nhắn khi A đang xem DM khác")).toBeVisible();
});

test("DM reconnect catch-up: messages sent while offline arrive once each, in order", async () => {
  const network = await networkSwitch(page);
  await network(true);
  await expect(page.getByText("Mất kết nối mạng.")).toBeVisible();
  await page.waitForTimeout(1500);
  const missed = Array.from({ length: 6 }, (_, i) => `DM lúc offline ${i + 1}`);
  for (const content of missed) await api(B.token, "POST", `/dms/${dmId}/messages`, { content });
  await page.waitForTimeout(1500);
  await expect(messageText(missed[0])).toHaveCount(0);
  await network(false);
  for (const content of missed) await expect(messageText(content)).toHaveCount(1, { timeout: 20_000 });
  const texts = await log().getByRole("article").allInnerTexts();
  const at = missed.map((m) => texts.findIndex((t) => t.includes(m)));
  expect(at).toEqual([...at].sort((x, y) => x - y));
  await page.waitForTimeout(500);
  for (const content of missed) await expect(messageText(content)).toHaveCount(1); // still once
});

test("presence flips live when B's socket disconnects and connects", async () => {
  await expect(dmButton(B)).toContainText("Đang hoạt động");
  bConn.close();
  await expect(dmButton(B)).not.toContainText("Đang hoạt động");
  await expect(page.getByRole("heading", { name: B.user.username }).locator("..").getByText("Ngoại tuyến")).toBeVisible();
  bConn = await connect(B);
  await expect(dmButton(B)).toContainText("Đang hoạt động");
});

test("a send refused by the server (the other side blocked, silently) closes the composer and keeps the text", async () => {
  const H = await newUser("sh");
  await befriend(A, H);
  await goFriends();
  await friendRows().filter({ hasText: H.user.username }).getByRole("button", { name: `Nhắn tin với ${H.user.username}` }).click();
  await composer().fill("Tin trước khi bị chặn");
  await composer().press("Enter");
  await expect(messageText("Tin trước khi bị chặn")).toBeVisible();
  await api(H.token, "PUT", `/blocks/${A.user.id}`); // A's window is not told
  await composer().fill("Tin này sẽ bị từ chối");
  await composer().press("Enter");
  const failed = log().getByRole("article", { name: "Gửi thất bại" });
  await expect(failed).toContainText("Tin này sẽ bị từ chối");
  await expect(composer()).toBeDisabled();
  await expect(composer()).toHaveAttribute("placeholder", /không còn là bạn bè/);
  await expect(messageText("Tin trước khi bị chặn")).toBeVisible(); // history stays readable
  await expect(failed.getByRole("button", { name: "Gửi lại" })).toBeVisible();
});

test("A blocks B: friend gone, composer closed with the reason, history readable, never shown online; unblock does not restore the friendship", async () => {
  await goFriends();
  await tab(/^Tất cả/).click();
  await friendRows().filter({ hasText: B.user.username }).getByRole("button", { name: `Tuỳ chọn cho ${B.user.username}` }).click();
  await page.getByRole("button", { name: "Chặn", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Chặn ${B.user.username}?` });
  await dialog.getByRole("button", { name: "Chặn", exact: true }).click();
  await expect(friendRows().filter({ hasText: B.user.username })).toHaveCount(0);
  await expect(tab(/^Đã chặn/)).toHaveText("Đã chặn (1)");

  await dmButton(B).click();
  await expect(composer()).toBeDisabled();
  await expect(composer()).toHaveAttribute("placeholder", new RegExp(`Bạn đã chặn ${B.user.username}`));
  await expect(messageText("B nhắn khi A đang xem DM khác")).toBeVisible();
  await expect(dmButton(B)).not.toContainText("Đang hoạt động"); // B's socket IS connected; blocked users never show as online
  await expect(page.getByRole("heading", { name: B.user.username }).locator("..").getByText("Ngoại tuyến")).toBeVisible();

  await goFriends();
  await tab(/^Đã chặn/).click();
  await expect(page.getByRole("list", { name: "Danh sách đã chặn" }).getByText(B.user.username)).toBeVisible();
  await page.getByRole("button", { name: "Bỏ chặn" }).click();
  await expect(page.getByText("Chưa chặn ai")).toBeVisible();
  await tab(/^Tất cả/).click();
  await expect(friendRows().filter({ hasText: B.user.username })).toHaveCount(0); // not restored
  await dmButton(B).click();
  await expect(composer()).toBeDisabled();
  await expect(composer()).toHaveAttribute("placeholder", /không còn là bạn bè/);
  expect(await status(B.token, "POST", `/dms/${dmId}/messages`, { content: "x" })).toBe(403);
});

test("Home survives 60 friends and 40 DMs at 1280x800 and 960x600 (no horizontal overflow, long names cut)", async () => {
  test.setTimeout(180_000);
  const longTag = "n".repeat(17) + run.slice(-5); // the run id sits early: register() cuts names at 32 characters
  const users: Session[] = [];
  for (let batch = 0; batch < 6; batch++) {
    users.push(...(await Promise.all(Array.from({ length: 10 }, (_, i) => newUser(batch === 0 && i === 0 ? longTag : `l${batch}${i}`)))));
  }
  await Promise.all(users.map((u) => api(A.token, "POST", "/friends/requests", { username: u.user.username })));
  await Promise.all(users.map((u) => api(u.token, "POST", `/friends/requests/${A.user.id}/accept`)));
  await Promise.all(users.slice(0, 40).map((u) => api(u.token, "POST", "/dms", { userId: A.user.id }))); // dm:new reaches A live
  await goFriends();
  await tab(/^Tất cả/).click();
  await expect(friendRows()).toHaveCount(61); // the 60 plus D
  await expect.poll(async () => dmList().getByRole("listitem").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(41);

  for (const [w, h] of [
    [1280, 800],
    [960, 600],
  ] as const) {
    await resize(app, w, h);
    await page.waitForTimeout(300);
    await expectNoHorizontalOverflow([
      page.getByRole("navigation", { name: "Kênh" }),
      dmList(),
      page.locator("main"),
      page.getByRole("list", { name: "Danh sách bạn bè" }),
      page.locator("aside"),
      page.locator("body"),
    ]);
    await expectNoHorizontalOverflow([page.locator("main > div").first()]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    // the DM column scrolls inside itself; the shell does not grow
    expect(await dmList().evaluate((el) => el.parentElement!.scrollHeight > el.parentElement!.clientHeight)).toBe(true);
  }
  await expectEllipsis(dmList().getByRole("button", { name: new RegExp(longTag) }).locator("span.truncate"));
  await expectEllipsis(friendRows().filter({ hasText: longTag }).locator("span.truncate").first());
  await resize(app, 1280, 800);
});
