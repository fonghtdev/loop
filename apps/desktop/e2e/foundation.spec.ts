import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { api, expectNoHorizontalOverflow, launchAs, register, resize, run, type Session } from "./helpers";

// Redesign R1 foundation, measured through the DOM (no pictures): fonts, materials, appearance preferences, motion,
// focus ring, overflow. Real dev server + docker; everyone but the app user is an API script.
let app: ElectronApplication;
let page: Page;
let A: Session;

const html = () => page.evaluate(() => ({ grain: document.documentElement.dataset.grain, motion: document.documentElement.dataset.motion }));
const style = (selector: string, prop: string) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const openSettings = async () => {
  await page.getByRole("button", { name: "Cài đặt của bạn" }).click();
  await expect(page.getByRole("heading", { name: "Cài đặt của bạn" })).toBeVisible();
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  A = await register("fd");
  await api(A.token, "POST", "/guilds", { name: `Nen tang ${run}` });
  ({ app, page } = await launchAs(A));
});
test.afterAll(async () => void (await app?.close().catch(() => undefined)));

test("Vietnamese glyphs resolve to the self-hosted fonts", async () => {
  const sample = "ă â đ ê ô ơ ư àáảãạ ằắẳẵặ ầấẩẫậ èéẻẽẹ ềếểễệ ìíỉĩị òóỏõọ ồốổỗộ ờớởỡợ ùúủũụ ừứửữự ỳýỷỹỵ";
  const result = await page.evaluate(async (text) => {
    const out: Record<string, boolean | string[]> = {};
    for (const font of ["800 20px 'Plus Jakarta Sans Variable'", "400 15px 'Be Vietnam Pro'"]) {
      await document.fonts.load(font, text);
      out[font] = document.fonts.check(font, text);
    }
    out.loaded = [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, ""));
    return out;
  }, sample);
  expect(result["800 20px 'Plus Jakarta Sans Variable'"]).toBe(true);
  expect(result["400 15px 'Be Vietnam Pro'"]).toBe(true);
  expect(result.loaded).toContain("Plus Jakarta Sans Variable");
  // headings really use it (not the fallback) and numerals are tabular
  expect(await style("h1", "font-family")).toContain("Plus Jakarta Sans Variable");
});

test("film grain is a background layer on the solid surfaces and the setting switches it", async () => {
  expect(await html()).toEqual({ grain: "on", motion: "system" });
  for (const sel of ["main", "nav[aria-label='Kênh']", "aside"]) expect(await style(sel, "background-image"), sel).toContain("data:image/svg+xml");
  expect(await style("main", "backdrop-filter")).toBe("none");

  await openSettings();
  const grain = page.getByRole("switch", { name: "Hạt phim" });
  await expect(grain).toHaveAttribute("aria-checked", "true");
  await grain.click();
  await expect(grain).toHaveAttribute("aria-checked", "false");
  expect((await html()).grain).toBe("off");
  for (const sel of ["main", "nav[aria-label='Kênh']", "aside"]) expect(await style(sel, "background-image"), sel).not.toContain("data:image/svg+xml");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("loop.appearance")!))).toEqual({ grain: "off", motion: "system" });
  await grain.click();
  expect((await html()).grain).toBe("on");
  expect(await style("main", "background-image")).toContain("data:image/svg+xml");
});

test("the motion preference reaches CSS: reduced = 1 ms, full overrides the OS, system follows the OS", async () => {
  const cdp = await page.context().newCDPSession(page);
  const duration = () => style("button[aria-label='Đăng xuất']", "transition-duration");
  const choose = async (name: string) => {
    await page.locator("label").filter({ hasText: new RegExp(`^${name}$`) }).click();
    await expect(page.getByRole("radio", { name })).toBeChecked();
  };

  await choose("Đầy đủ");
  expect((await html()).motion).toBe("full");
  expect(await duration()).not.toBe("0.001s");

  await choose("Giảm");
  expect((await html()).motion).toBe("reduced");
  expect(await duration()).toBe("0.001s");

  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await choose("Theo hệ thống");
  expect(await duration()).toBe("0.001s"); // the OS asks for less motion
  await choose("Đầy đủ");
  expect(await duration()).not.toBe("0.001s"); // the in-app choice wins over the OS
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await choose("Theo hệ thống");
  expect(await duration()).not.toBe("0.001s");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("loop.appearance")!).motion)).toBe("system");
});

test("base components: primary gradient, cosmic focus ring, dialog glass opens with a transition", async () => {
  await page.keyboard.press("Escape");
  const rail = page.getByRole("navigation", { name: "Danh sách máy chủ" });
  await rail.getByRole("button", { name: "Tạo máy chủ" }).click();
  const dialog = page.getByRole("dialog", { name: "Tạo máy chủ" });
  await expect(dialog).toBeVisible();
  const d = await dialog.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { blur: cs.backdropFilter, props: cs.transitionProperty, radius: cs.borderTopLeftRadius };
  });
  expect(d.blur).toMatch(/^blur\(/);
  expect(d.props).toContain("opacity");
  expect(d.radius).toBe("28px");
  await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

  const submit = dialog.getByRole("button", { name: /^Tạo/ }).last();
  expect(await submit.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("linear-gradient");
  const field = dialog.getByLabel("Tên máy chủ");
  await field.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const ring = await field.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { outline: cs.outlineColor, width: cs.outlineWidth, border: cs.borderTopColor };
  });
  expect(ring).toEqual({ outline: "rgb(169, 182, 246)", width: "2px", border: "rgb(169, 182, 246)" }); // cosmic-300
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

for (const [w, h] of [
  [1280, 800],
  [960, 600],
] as const)
  test(`no horizontal overflow at ${w}x${h}: home, server, settings`, async () => {
    await resize(app, w, h);
    const rail = page.getByRole("navigation", { name: "Danh sách máy chủ" });
    const check = () => expectNoHorizontalOverflow([page.locator("main"), page.locator("nav[aria-label='Kênh']"), page.locator("aside"), page.locator("body")]);
    await rail.getByRole("button", { name: "Trang chủ" }).click();
    await check();
    await rail.getByRole("button", { name: new RegExp(`^Nen tang ${run}`) }).click();
    await check();
    await openSettings();
    await check();
    await page.keyboard.press("Escape");
  });
