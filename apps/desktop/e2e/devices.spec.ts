import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { api, expectNoHorizontalOverflow, launchAs, register, resize, run, type Session } from "./helpers";
import { channelToken, joinRoom, leaveAll } from "./livekit";

// 9f part 6: microphone / speaker / camera pickers against Chromium's fake devices, applied to a real voice session.
let app: ElectronApplication;
let page: Page;
let A: Session;
let B: Session;
let voz: string;

const select = (name: string) => page.getByLabel(name, { exact: true });
const optionIds = (name: string) => select(name).locator("option").evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => o.value).filter(Boolean));
const gum = () => page.evaluate(() => (window as unknown as { __gum: string[] }).__gum);
const openSettings = () => page.getByRole("button", { name: "Cài đặt của bạn" }).click();

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  [A, B] = await Promise.all([register("da"), register("db")]);
  const { guild } = await api<{ guild: { id: string } }>(A.token, "POST", "/guilds", { name: `Dev ${run}` });
  voz = (await api<{ id: string }>(A.token, "POST", `/guilds/${guild.id}/channels`, { name: "voz", type: "VOICE" })).id;
  const { code } = await api<{ code: string }>(A.token, "POST", `/guilds/${guild.id}/invites`, {});
  await api(B.token, "POST", `/invites/${code}/join`);
  ({ app, page } = await launchAs(A, { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }));
  await page.evaluate(() => {
    const w = window as unknown as { __gum: string[] };
    w.__gum = [];
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => (w.__gum.push(JSON.stringify(c)), orig(c));
  });
});
test.afterAll(async () => {
  await leaveAll();
  await app?.close().catch(() => undefined);
});

test("the pickers list the fake devices with names, and the choice is stored", async () => {
  await openSettings();
  await expect(select("Micro")).toBeVisible();
  await expect.poll(async () => (await optionIds("Micro")).length).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await optionIds("Camera")).length).toBeGreaterThanOrEqual(1);
  await expect(page.getByText("Chưa đọc được tên thiết bị")).toHaveCount(0);
  expect(await select("Micro").locator("option").allInnerTexts()).toEqual(expect.arrayContaining([expect.stringMatching(/Fake/i)]));
  const [first] = await optionIds("Micro");
  await select("Micro").selectOption(first);
  expect(await page.evaluate(() => localStorage.getItem("loop.devices"))).toContain(first);
  for (const [w, h] of [[1280, 800], [960, 600]]) {
    await resize(app, w, h);
    await expectNoHorizontalOverflow([page.locator("main"), page.locator("main section").first()]);
  }
  await resize(app, 1280, 800);
});

test("the chosen microphone is used when joining, and a new choice moves the live session", async () => {
  const [m1, m2] = await optionIds("Micro");
  await select("Micro").selectOption(m1);
  await page.getByRole("button", { name: "Đóng cài đặt" }).click();
  await page.getByRole("navigation", { name: "Danh sách máy chủ" }).getByRole("button", { name: `Dev ${run}` }).click();
  await page.getByRole("button", { name: "Kênh thoại voz", exact: true }).click();
  await expect(page.getByRole("region", { name: "Đang trong cuộc gọi" }).getByText("Đã kết nối giọng nói", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await gum()).some((c) => c.includes(m1))).toBe(true);
  await openSettings();
  await select("Micro").selectOption(m2);
  await expect.poll(async () => (await gum()).some((c) => c.includes(m2))).toBe(true);
});

test("the chosen speaker is set on the audio elements of the session", async () => {
  const outputs = await optionIds("Loa");
  test.skip(outputs.length === 0, "this machine lists no selectable speaker");
  const b = await joinRoom(await channelToken(B, voz));
  await expect.poll(() => page.evaluate(() => document.querySelectorAll("audio").length)).toBe(1);
  await select("Loa").selectOption(outputs[0]);
  await expect.poll(() => page.evaluate(() => (document.querySelector("audio") as HTMLAudioElement).sinkId)).toBe(outputs[0]);
  await select("Loa").selectOption("");
  await expect.poll(() => page.evaluate(() => (document.querySelector("audio") as HTMLAudioElement).sinkId)).toBe("");
  await b.leave();
});

test("a chosen device that disappears falls back to the default, with a note", async () => {
  const chosen = await select("Micro").inputValue();
  expect(chosen).not.toBe("");
  const before = (await gum()).length;
  await page.evaluate((gone) => {
    const md = navigator.mediaDevices;
    const real = md.enumerateDevices.bind(md);
    md.enumerateDevices = async () => (await real()).filter((d) => d.deviceId !== gone);
    md.dispatchEvent(new Event("devicechange"));
  }, chosen);
  await expect(select("Micro")).toHaveValue("");
  await expect(page.getByText("Thiết bị đã chọn không còn kết nối")).toBeVisible();
  await expect.poll(async () => (await gum()).slice(before).some((c) => c.includes("default"))).toBe(true);
  expect((await gum()).slice(before).some((c) => c.includes(chosen))).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem("loop.devices"))).toContain(chosen); // remembered for when it returns
});
