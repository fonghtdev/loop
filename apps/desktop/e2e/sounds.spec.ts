import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { api, launchAs, register, run, type Session } from "./helpers";
import { channelToken, joinRoom, leaveAll, type Peer } from "./livekit";

// Join/leave sounds: A is the app (fake media devices); "window B" is a real LiveKit participant (rtc-node) in the
// same room. The renderer counts the sounds it really plays on window.__loopSounds (only exposed under LOOP_E2E).
let app: ElectronApplication;
let page: Page;
let A: Session;
let B: Session;
let guildName: string;
let voz: string;
let peer: Peer | null = null;

const channelButton = () => page.getByRole("button", { name: "Kênh thoại voz-snd", exact: true });
const bar = () => page.getByRole("region", { name: "Đang trong cuộc gọi" });
const strip = () => page.getByRole("region", { name: "Tài khoản" });
const connected = () => expect(bar().getByText("Đã kết nối giọng nói")).toBeVisible({ timeout: 20_000 });
const counts = () => page.evaluate(() => ({ ...(window as unknown as { __loopSounds: Record<string, number> }).__loopSounds }));
const settle = () => page.waitForTimeout(700); // longer than the coalescing window: "exactly one" really means one
const leaveApp = async () => {
  await bar().getByRole("button", { name: "Rời kênh thoại" }).click();
  await expect(bar()).toBeHidden();
};
const bJoins = async () => (peer = await joinRoom(await channelToken(B, voz), { mic: false }));
const bLeaves = async () => {
  await peer?.leave();
  peer = null;
};
const openSettings = () => strip().getByRole("button", { name: "Cài đặt của bạn" }).click();
const soundSwitch = () => page.getByRole("switch", { name: "Âm báo vào/ra phòng thoại" });

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  [A, B] = await Promise.all([register("sna"), register("snb")]);
  guildName = `Snd ${run}`;
  const { guild } = await api<{ guild: { id: string } }>(A.token, "POST", "/guilds", { name: guildName });
  voz = (await api<{ id: string }>(A.token, "POST", `/guilds/${guild.id}/channels`, { name: "voz-snd", type: "VOICE" })).id;
  const { code } = await api<{ code: string }>(A.token, "POST", `/guilds/${guild.id}/invites`, {});
  await api(B.token, "POST", `/invites/${code}/join`);
  ({ app, page } = await launchAs(A, { userData: mkdtempSync(join(tmpdir(), "loop-e2e-snd-")), args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }));
  await page.getByRole("navigation", { name: "Danh sách máy chủ" }).getByRole("button", { name: guildName }).click();
});
test.afterAll(async () => {
  await leaveAll();
  await app?.close().catch(() => undefined);
});

test("own join and leave, another person joining and leaving: one sound each", async () => {
  await channelButton().click();
  await connected();
  await settle();
  expect(await counts()).toEqual({ selfJoin: 1 });
  await bJoins();
  await expect.poll(counts).toEqual({ selfJoin: 1, join: 1 });
  await settle();
  expect(await counts()).toEqual({ selfJoin: 1, join: 1 });
  await bLeaves();
  await expect.poll(counts).toEqual({ selfJoin: 1, join: 1, leave: 1 });
  await leaveApp();
  await expect.poll(counts).toEqual({ selfJoin: 1, join: 1, leave: 1, selfLeave: 1 });
});

test("people already in the room when we join are silent", async () => {
  await bJoins();
  await channelButton().click();
  await connected();
  await settle();
  expect(await counts()).toEqual({ selfJoin: 2, join: 1, leave: 1, selfLeave: 1 });
  await leaveApp();
  await bLeaves();
  await expect.poll(counts).toEqual({ selfJoin: 2, join: 1, leave: 1, selfLeave: 2 });
});

test("deafened: no sound for others or for our own leave", async () => {
  await channelButton().click();
  await connected();
  await strip().getByRole("button", { name: "Tắt tiếng nghe" }).click();
  await bJoins();
  await settle();
  await bLeaves();
  await settle();
  await leaveApp();
  await settle();
  expect(await counts()).toEqual({ selfJoin: 3, join: 1, leave: 1, selfLeave: 2 });
});

test("setting off (Âm thanh in the settings): nothing plays; on again: it does", async () => {
  await openSettings();
  await expect(page.getByRole("heading", { name: "Âm thanh", exact: true })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Âm lượng âm báo" })).toHaveValue("60");
  await expect(soundSwitch()).toHaveAttribute("aria-checked", "true");
  await soundSwitch().click();
  await expect(soundSwitch()).toHaveAttribute("aria-checked", "false");
  await channelButton().click();
  await connected();
  await bJoins();
  await settle();
  await bLeaves();
  await settle();
  await leaveApp();
  await settle();
  expect(await counts()).toEqual({ selfJoin: 3, join: 1, leave: 1, selfLeave: 2 });
  await openSettings();
  await soundSwitch().click();
  await expect(soundSwitch()).toHaveAttribute("aria-checked", "true");
  await channelButton().click();
  await connected();
  await expect.poll(counts).toMatchObject({ selfJoin: 4 });
  await leaveApp();
});
