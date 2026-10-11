import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { api, befriend, expectNoHorizontalOverflow, launchAs, launchOptions, password, register, resize, run, type Session } from "./helpers";

// Redesign R2 (auth screens, first run, empty states), checked through the DOM and timings (no pictures).
// Real dev server + docker; everyone but the app user is an API script.
const newDir = () => mkdtempSync(join(tmpdir(), "loop-e2e-r2-"));
const rail = (page: Page) => page.getByRole("navigation", { name: "Danh sách máy chủ" });
const consoleErrors: string[] = [];
const watch = (page: Page) => {
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
};
const reduceMotion = async (page: Page, on: boolean) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "no-preference" }] });
};

test.describe("auth screens", () => {
  let app: ElectronApplication;
  let page: Page;
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    app = await _electron.launch(launchOptions(newDir()));
    page = await app.firstWindow();
    watch(page);
    await expect(page.getByRole("heading", { name: "Chào mừng trở lại" })).toBeVisible();
  });
  test.afterAll(async () => void (await app?.close().catch(() => undefined)));

  test("typing right after load lands exactly in the autofocused field (6 reloads)", async () => {
    for (let i = 0; i < 6; i++) {
      await page.reload();
      await page.waitForSelector("input[type=email]");
      const email = `go.nhanh.${i}@example.com`;
      const pw = `mat-khau-${i}-ạặữ`;
      await page.keyboard.type(email, { delay: 0 }); // no waiting at all between load and typing
      await page.keyboard.press("Tab");
      await page.keyboard.type(pw, { delay: 0 });
      await expect(page.getByLabel("Email")).toHaveValue(email);
      await expect(page.getByLabel("Mật khẩu", { exact: true })).toHaveValue(pw);
      await expect(page.getByLabel("Mật khẩu", { exact: true })).toBeFocused(); // Tab skipped the folded username field
    }
  });

  test("the entrance runs inside 900 ms, never hides an input, and is the end state at once under reduced motion", async () => {
    await page.addInitScript(() => {
      const r: Record<string, number> = ((window as unknown as { __r2: Record<string, number> }).__r2 = { minOpacity: 1, logoStart: -1 });
      new MutationObserver(() => {
        const card = document.querySelector("[data-enter-card]");
        if (!card || r.mount) return;
        r.mount = performance.now();
        const logo = document.querySelector<SVGPathElement>("svg path[stroke-dasharray]");
        const tick = () => {
          const items = [...document.querySelectorAll<HTMLElement>("[data-enter], [data-enter-card]")];
          for (const el of items) r.minOpacity = Math.min(r.minOpacity, +getComputedStyle(el).opacity);
          if (logo && r.logoStart < 0) r.logoStart = +getComputedStyle(logo).strokeDashoffset.replace("px", "");
          if (items.some((el) => el.style.opacity !== "")) requestAnimationFrame(tick);
          else r.done = performance.now();
        };
        requestAnimationFrame(tick);
      }).observe(document, { childList: true, subtree: true });
    });
    const measure = async () => {
      await page.reload();
      await page.waitForFunction(() => (window as unknown as { __r2: { done?: number } }).__r2.done !== undefined);
      return page.evaluate(() => {
        const r = (window as unknown as { __r2: Record<string, number> }).__r2;
        const inputs = [...document.querySelectorAll<HTMLInputElement>("input")].map((i) => getComputedStyle(i).pointerEvents);
        return { ms: Math.round(r.done - r.mount), minOpacity: r.minOpacity, logoStart: r.logoStart, inputs };
      });
    };
    const full = await measure();
    console.log(`auth entrance: ${full.ms} ms (min opacity seen ${full.minOpacity}, logo dashoffset at start ${full.logoStart})`);
    expect(full.ms).toBeLessThanOrEqual(900);
    expect(full.ms).toBeGreaterThan(300); // it really plays
    expect(full.minOpacity).toBeLessThan(0.5);
    expect(full.logoStart).toBeGreaterThan(0.5); // the mark starts undrawn
    expect(full.inputs.every((p) => p !== "none")).toBe(true);

    await reduceMotion(page, true);
    const reduced = await measure();
    console.log(`auth entrance, reduced motion: ${reduced.ms} ms (min opacity ${reduced.minOpacity})`);
    expect(reduced.minOpacity).toBe(1);
    expect(reduced.ms).toBeLessThan(100);
    const state = await page.evaluate(() => ({
      orbits: [...document.querySelectorAll("[data-orbit]")].map((e) => getComputedStyle(e).strokeDashoffset),
      logo: [...document.querySelectorAll("svg path[stroke-dasharray]")].map((e) => getComputedStyle(e).strokeDashoffset),
    }));
    expect(new Set(state.orbits)).toEqual(new Set(["0px"]));
    expect(new Set(state.logo)).toEqual(new Set(["0px"]));
    await reduceMotion(page, false);
  });

  test("the aurora drifts only here, with transform only, and stands still under reduced motion", async () => {
    await page.reload();
    const blob = page.locator(".aurora-blob").first();
    await expect(blob).toBeVisible();
    const info = () => blob.evaluate((el) => ({ name: getComputedStyle(el).animationName, dur: getComputedStyle(el).animationDuration, filter: getComputedStyle(el).filter }));
    expect(await info()).toEqual({ name: "drift-a", dur: "48s", filter: "none" });
    await reduceMotion(page, true);
    expect((await info()).dur).toBe("0.001s");
    await reduceMotion(page, false);
  });

  test("login <-> register keeps what was typed and never re-mounts a shared input; the card grows smoothly", async () => {
    await page.reload();
    const email = page.getByLabel("Email");
    const pw = page.getByLabel("Mật khẩu", { exact: true });
    await email.fill("giu.nguyen@example.com");
    await pw.fill("mat-khau-dai-123");
    await page.evaluate(() => document.querySelectorAll("input").forEach((el, i) => ((el as unknown as Record<string, number>).__mark = i + 1)));
    const username = page.getByLabel("Tên người dùng");
    await expect(username).toBeHidden(); // folded away in login mode
    const card = page.locator("[data-enter-card]");
    const startHeight = (await card.boundingBox())!.height;

    const sampling = page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const el = document.querySelector("[data-enter-card]")!;
          const out: number[] = [];
          const t0 = performance.now();
          const frame = () => {
            out.push(el.getBoundingClientRect().height);
            if (performance.now() - t0 < 1500) requestAnimationFrame(frame);
            else resolve(out);
          };
          frame();
        }),
    );
    await page.getByRole("button", { name: "Tạo tài khoản" }).click();
    const heights = await sampling;
    const steps = heights.slice(1).map((h, i) => Math.abs(h - heights[i]));
    console.log(`morph: card ${startHeight} -> ${heights.at(-1)} px, largest per-frame step ${Math.max(...steps).toFixed(1)} px over ${heights.length} frames`);
    expect(heights.at(-1)! - startHeight).toBeGreaterThan(60); // the username row (and the password hint) opened
    expect(new Set(heights.map(Math.round)).size).toBeGreaterThan(4); // in-between sizes: a transition, not a jump
    expect(Math.max(...steps)).toBeLessThan((heights.at(-1)! - startHeight) * 0.6); // no frame carries most of the change

    await expect(username).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tạo tài khoản" })).toBeVisible();
    await expect(email).toHaveValue("giu.nguyen@example.com");
    await expect(pw).toHaveValue("mat-khau-dai-123");
    await expect(email).toBeFocused();
    await username.fill("ten_moi");
    await page.getByRole("button", { name: "Đăng nhập", exact: true }).click(); // back
    await expect(page.getByRole("heading", { name: "Chào mừng trở lại" })).toBeVisible();
    await expect(username).toBeHidden();
    await expect(email).toHaveValue("giu.nguyen@example.com");
    expect(await page.evaluate(() => [...document.querySelectorAll("input")].map((el) => (el as unknown as Record<string, number>).__mark))).toEqual([1, 2, 3]);
    // the folded field is out of the tab order and the accessibility tree
    await email.focus();
    await page.keyboard.press("Tab");
    await expect(pw).toBeFocused();
  });

  test("errors: slide in with a shake, aria-live unchanged, server error announced; the server mapping is intact", async () => {
    await page.reload();
    await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
    const emailError = page.getByText("Vui lòng điền mục này.").first();
    await expect(emailError).toBeVisible();
    expect(await emailError.evaluate((el) => ({ anim: getComputedStyle(el).animationName, live: el.parentElement!.getAttribute("aria-live") }))).toEqual({ anim: "err", live: "polite" });
    const shaken = page.getByLabel("Email").locator("xpath=..");
    expect(await shaken.evaluate((el) => getComputedStyle(el).animationName)).toBe("shake");
    await expect(page.getByLabel("Email")).toBeFocused(); // focus goes to the first invalid field

    await page.getByLabel("Email").fill("khong.co@example.com");
    await page.getByLabel("Mật khẩu", { exact: true }).fill("sai-mat-khau-1");
    await page.keyboard.press("Enter");
    const live = page.locator("[aria-live=assertive]").filter({ hasText: "Email hoặc mật khẩu không đúng." });
    await expect(live).toBeVisible();
    // show / hide password
    const reveal = page.getByRole("button", { name: "Hiện mật khẩu" });
    await reveal.click();
    await expect(page.getByLabel("Mật khẩu", { exact: true })).toHaveAttribute("type", "text");
    await expect(page.getByRole("button", { name: "Ẩn mật khẩu" })).toHaveAttribute("aria-pressed", "true");
  });

  test("glass only on the card; no horizontal overflow at 1280x800 and 960x600; hit targets >= 40px", async () => {
    await page.reload();
    await resize(app, 1280, 800);
    const glass = await page.locator("[data-enter-card]").evaluate((el) => getComputedStyle(el).backdropFilter);
    expect(glass).toMatch(/^blur\(\d+px\)/);
    expect(await page.locator("main").first().evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none");
    for (const [w, h] of [[1280, 800], [960, 600]]) {
      await resize(app, w, h);
      await page.getByRole("button", { name: "Tạo tài khoản" }).click();
      await page.waitForTimeout(400);
      await expectNoHorizontalOverflow([page.locator("html"), page.locator("body")]);
      for (const b of await page.getByRole("button").all()) {
        const box = await b.boundingBox();
        if (box) expect(box.height, await b.innerText()).toBeGreaterThanOrEqual(40);
      }
      await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
    }
  });

  test("register through the new markup creates the account and signs in", async () => {
    await page.reload();
    const name = `r2_${run}`;
    await page.getByRole("button", { name: "Tạo tài khoản" }).click();
    await page.getByLabel("Email").fill(`${name}@example.com`);
    await page.getByLabel("Tên người dùng").fill(name);
    await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Bạn bè" })).toBeVisible();
    await expect(page.getByRole("region", { name: `Chào mừng đến với Loop, ${name}` })).toBeVisible();
  });

  test("no console errors on the auth screens", () => {
    expect(consoleErrors.filter((e) => !/401|Unauthorized|Failed to load resource/.test(e))).toEqual([]);
  });
});

test.describe("first run and empty states", () => {
  test.describe.configure({ mode: "serial" });
  let A: Session; // brand new account
  let B: Session;
  let app: ElectronApplication;
  let page: Page;
  let userData: string;
  const welcome = () => page.getByRole("region", { name: /^Chào mừng đến với Loop/ });
  const checklist = () => page.getByRole("region", { name: "Bắt đầu" });
  const progress = (n: number) => expect(checklist().getByText(`${n} trên 4 bước`)).toBeVisible();

  test.beforeAll(async () => {
    [A, B] = await Promise.all([register("ra"), register("rb")]);
    userData = newDir();
    ({ app, page } = await launchAs(A, { userData }));
    watch(page);
  });
  test.afterAll(async () => void (await app?.close().catch(() => undefined)));

  test("a brand-new account sees the welcome page, the three cards and the checklist at 0 of 4", async () => {
    await expect(welcome()).toBeVisible();
    for (const name of ["Tạo máy chủ", "Tham gia bằng mã mời", "Thêm bạn"]) await expect(welcome().getByRole("button", { name })).toBeVisible();
    await expect(welcome().locator("svg[aria-hidden=true]")).toHaveCount(3);
    await progress(0);
    await expect(checklist().getByRole("listitem")).toHaveCount(4);
    await expect(checklist().getByRole("listitem").first()).toContainText("Chưa xong");
    // solid surfaces: no glass on the cards
    for (const el of [welcome().getByRole("button").first(), checklist()]) expect(await el.evaluate((n) => getComputedStyle(n).backdropFilter)).toBe("none");
    // the empty lists around it
    await expect(page.getByText("Chưa có cuộc trò chuyện nào")).toBeVisible();
    await expect(page.getByText("Chưa mở máy chủ nào")).toBeVisible();
  });

  test("the cards open the existing flows", async () => {
    await welcome().getByRole("button", { name: "Thêm bạn" }).click();
    await expect(page.getByLabel("Thêm bạn bằng tên người dùng")).toBeFocused();
    await welcome().getByRole("button", { name: "Tham gia bằng mã mời" }).click();
    const join = page.getByRole("dialog", { name: "Tham gia máy chủ" });
    await expect(join).toBeVisible();
    await expect(join.getByLabel("Mã mời")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(join).toBeHidden();
    await welcome().getByRole("button", { name: "Tạo máy chủ" }).click();
    const create = page.getByRole("dialog", { name: "Tạo máy chủ" });
    await expect(create.getByLabel("Tên máy chủ")).toBeFocused();
    await create.getByLabel("Tên máy chủ").fill(`Khoi dau ${run}`);
    await create.getByRole("button", { name: "Tạo máy chủ" }).click();
    await expect(create).toBeHidden();
    await expect(rail(page).getByRole("button", { name: `Khoi dau ${run}` })).toHaveAttribute("aria-current", "page");
  });

  test("an empty channel is a welcome scene; the checklist moved to 1 of 4 and the welcome page is gone", async () => {
    const log = page.getByRole("log");
    await expect(log.getByText("Đây là khởi đầu của #general")).toBeVisible();
    await expect(log.locator("svg[aria-hidden=true]")).toHaveCount(1);
    await page.getByRole("button", { name: "Trang chủ" }).click();
    await expect(page.getByRole("heading", { name: "Bạn bè" })).toBeVisible();
    await expect(welcome()).toHaveCount(0); // it has a server now
    await progress(1);
    await expect(checklist().getByRole("listitem").first()).toContainText("Đã xong");
  });

  test("sending a message and a friendship tick their steps, from real events", async () => {
    await rail(page).getByRole("button", { name: `Khoi dau ${run}` }).click();
    await page.getByRole("textbox", { name: /Nhắn vào/ }).fill("Xin chào cả nhà");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("log").getByText("Xin chào cả nhà")).toBeVisible();
    await page.getByRole("button", { name: "Trang chủ" }).click();
    await progress(2);
    await befriend(A, B);
    await progress(3); // friend:accepted updates the lists live
    const saved = await page.evaluate((id) => localStorage.getItem(`loop.firstRun.${id}`), A.user.id);
    expect(JSON.parse(saved!)).toEqual({ events: ["message"], dismissed: false });
  });

  test("empty friends tabs have a scene, a title and a hint", async () => {
    const C = await register("rc");
    const second = await launchAs(C, { userData: newDir() });
    watch(second.page);
    await second.page.getByRole("tab", { name: /Đang chờ/ }).click();
    await expect(second.page.getByText("Không có lời mời nào")).toBeVisible();
    await second.page.getByRole("tab", { name: /Đã chặn/ }).click();
    await expect(second.page.getByText("Chưa chặn ai")).toBeVisible();
    await second.page.getByRole("tab", { name: /Tất cả/ }).click();
    await expect(second.page.getByText("Chưa có bạn bè")).toBeVisible();
    await expect(second.page.getByRole("tabpanel").locator("svg[aria-hidden=true]")).toHaveCount(1);
    for (const [w, h] of [[1280, 800], [960, 600]]) {
      await resize(second.app, w, h);
      await second.page.waitForTimeout(300);
      await expectNoHorizontalOverflow([second.page.locator("html"), second.page.locator("main"), second.page.locator("nav[aria-label='Kênh']")]);
    }
    await second.app.close();
  });

  test("an empty voice channel shows its scene", async () => {
    // its own account: joining voice ticks the last open step of A's checklist, which other tests here still need
    const V = await register("rq");
    const guild = await api<{ guild: { id: string } }>(V.token, "POST", "/guilds", { name: `Thoai ${run}` });
    await api(V.token, "POST", `/guilds/${guild.guild.id}/channels`, { name: "phong-thoai", type: "VOICE" });
    const voiceApp = await launchAs(V, { userData: newDir() });
    const vp = voiceApp.page;
    watch(vp);
    await rail(vp).getByRole("button", { name: `Thoai ${run}` }).click();
    await vp.getByRole("button", { name: "Kênh thoại phong-thoai" }).click(); // a voice channel is joined by the click
    await expect(vp.getByRole("region", { name: "Đang trong cuộc gọi" }).getByText("Đã kết nối giọng nói", { exact: true })).toBeVisible({ timeout: 20_000 });
    await vp.getByRole("button", { name: "Mở phòng thoại" }).click(); // joining leaves the view where it was
    await vp.getByRole("button", { name: "Rời kênh thoại" }).click();
    await expect(vp.getByRole("region", { name: "Đang trong cuộc gọi" })).toBeHidden();
    await vp.reload(); // the place is restored: the room is open again, and LiveKit now says nobody is in it
    await expect(vp.getByText("Phòng đang yên tĩnh")).toBeVisible();
    await expect(vp.getByRole("main").locator("svg[viewBox='0 0 240 150']")).toHaveCount(1);
    await expect(vp.getByRole("button", { name: "Tham gia kênh thoại" })).toBeVisible();
    await voiceApp.app.close();
  });

  test("welcome page and checklist fit 1280x800 and 960x600 without horizontal overflow", async () => {
    const D = await register("rd");
    const third = await launchAs(D, { userData: newDir() });
    await expect(third.page.getByRole("region", { name: /^Chào mừng đến với Loop/ })).toBeVisible();
    for (const [w, h] of [[1280, 800], [960, 600]]) {
      await resize(third.app, w, h);
      await third.page.waitForTimeout(300);
      await expectNoHorizontalOverflow([third.page.locator("html"), third.page.locator("main"), third.page.getByRole("region", { name: /^Chào mừng/ })]);
    }
    for (const b of await third.page.getByRole("main").getByRole("button").all()) {
      const box = await b.boundingBox();
      if (box) expect(box.height, await b.innerText()).toBeGreaterThanOrEqual(40);
    }
    await third.app.close();
  });

  test("hiding the checklist is permanent: it survives a relaunch and belongs to this account only", async () => {
    await page.getByRole("button", { name: "Trang chủ" }).click();
    await checklist().getByRole("button", { name: "Ẩn danh sách" }).click();
    await expect(checklist()).toHaveCount(0);
    await app.close();
    ({ app, page } = await _electron.launch(launchOptions(userData)).then(async (a) => ({ app: a, page: await a.firstWindow() })));
    watch(page);
    await expect(page.getByRole("heading", { name: "Bạn bè" })).toBeVisible(); // the session was restored
    await page.waitForTimeout(500);
    await expect(checklist()).toHaveCount(0); // dismissed accounts never see it again
    // sign out and in as another account in the same profile: that account still has its list
    await page.getByRole("button", { name: "Menu tài khoản" }).click();
    await page.getByRole("button", { name: "Đăng xuất" }).click();
    await page.getByLabel("Email").fill(`${B.user.username}@example.com`);
    await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Bạn bè" })).toBeVisible();
    await expect(checklist()).toBeVisible();
    expect(await page.evaluate((id) => localStorage.getItem(`loop.firstRun.${id}`), B.user.id)).toBeNull();
  });

  test("no console errors in the first-run flows", () => {
    expect(consoleErrors.filter((e) => !/401|Unauthorized|Failed to load resource/.test(e))).toEqual([]);
  });
});

test.describe("the checklist ends", () => {
  // The last open step is "friend", which can finish while the Home page is open (friend:accepted arrives live).
  const prepare = async (tag: string, reduced: boolean) => {
    const S = await register(tag);
    const O = await register(`${tag}o`);
    await api(S.token, "POST", "/guilds", { name: `Fin ${tag} ${run}` });
    const { app, page } = await launchAs(S, { userData: newDir() });
    watch(page);
    await page.evaluate((id) => localStorage.setItem(`loop.firstRun.${id}`, JSON.stringify({ events: ["message", "voice"], dismissed: false })), S.user.id);
    await reduceMotion(page, reduced);
    await page.reload();
    const checklist = page.getByRole("region", { name: "Bắt đầu" });
    await expect(checklist.getByText("3 trên 4 bước")).toBeVisible();
    await api(O.token, "POST", "/friends/requests", { username: S.user.username });
    await api(S.token, "POST", `/friends/requests/${O.user.id}/accept`);
    return { app, page, checklist };
  };

  test("full motion: a short thank-you, then it hides itself", async () => {
    const { app, page, checklist } = await prepare("fm", false);
    await expect(page.getByRole("status").filter({ hasText: "Bạn đã làm xong mọi bước" })).toBeVisible();
    await expect(checklist).toHaveCount(0, { timeout: 6000 });
    await app.close();
  });

  test("reduced motion: no celebration, it simply goes", async () => {
    const { app, page, checklist } = await prepare("rm", true);
    await expect(checklist).toHaveCount(0);
    await expect(page.getByText("Bạn đã làm xong mọi bước")).toHaveCount(0);
    await app.close();
  });
});

test("the first message and the first voice join are remembered for the account", async () => {
  const S = await register("rv");
  const g = await api<{ guild: { id: string } }>(S.token, "POST", "/guilds", { name: `Ghi nho ${run}` });
  await api(S.token, "POST", `/guilds/${g.guild.id}/channels`, { name: "thoai-ghi-nho", type: "VOICE" });
  const { app, page } = await launchAs(S, { userData: newDir(), args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const saved = () => page.evaluate((id) => JSON.parse(localStorage.getItem(`loop.firstRun.${id}`) ?? "null"), S.user.id);
  expect(await saved()).toBeNull(); // nothing written until something happens
  await rail(page).getByRole("button", { name: `Ghi nho ${run}` }).click();
  await page.getByRole("button", { name: "Kênh thoại thoai-ghi-nho" }).click(); // a voice channel is joined by the click
  await expect(page.getByRole("region", { name: "Đang trong cuộc gọi" }).getByText("Đã kết nối giọng nói", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect.poll(saved).toEqual({ events: ["voice"], dismissed: false });
  await page.getByRole("list", { name: "Danh sách kênh" }).getByRole("button", { name: "general", exact: true }).click();
  await page.getByRole("textbox", { name: /Nhắn vào/ }).fill("tin đầu tiên");
  await page.keyboard.press("Enter");
  await expect.poll(saved).toEqual({ events: ["voice", "message"], dismissed: false });
  await app.close();
});
