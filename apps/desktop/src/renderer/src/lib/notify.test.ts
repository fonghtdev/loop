import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../../shared/settings";
import type { Message } from "./chat";
import { callNotice, messageNotice, shouldNotify, type NotifyDecision } from "./notify";

const base: NotifyDecision = {
  kind: "message",
  isOwn: false,
  windowFocused: false,
  openConversation: null,
  conversation: "dm:d1",
  blocked: false,
  settings: { notifications: true },
  myStatus: "online",
};
const decide = (over: Partial<NotifyDecision>) => shouldNotify({ ...base, ...over });

describe("shouldNotify", () => {
  it("a DM from someone else while the window is not focused", () => {
    expect(decide({})).toBe(true);
  });
  it("a DM while focused on another conversation, or on none", () => {
    expect(decide({ windowFocused: true, openConversation: "dm:d2" })).toBe(true);
    expect(decide({ windowFocused: true, openConversation: "channel:c1" })).toBe(true);
    expect(decide({ windowFocused: true, openConversation: null })).toBe(true);
  });
  it("never while looking at that very conversation", () => {
    expect(decide({ windowFocused: true, openConversation: "dm:d1" })).toBe(false);
  });
  it("the conversation being open but the window not focused still notifies", () => {
    expect(decide({ windowFocused: false, openConversation: "dm:d1" })).toBe(true);
  });
  it("never for our own messages, blocked people, or when notifications are off", () => {
    expect(decide({ isOwn: true })).toBe(false);
    expect(decide({ blocked: true })).toBe(false);
    expect(decide({ settings: { notifications: false } })).toBe(false);
  });
  it("do-not-disturb silences messages and calls; every other status notifies", () => {
    expect(decide({ myStatus: "dnd" })).toBe(false);
    expect(decide({ myStatus: "dnd", kind: "call" })).toBe(false);
    for (const myStatus of ["online", "idle", "invisible"] as const) expect(decide({ myStatus })).toBe(true);
  });
  it("never for a guild channel (there are no mentions yet)", () => {
    expect(decide({ conversation: "channel:c1" })).toBe(false);
  });
  it("an incoming call follows the same rules", () => {
    expect(decide({ kind: "call" })).toBe(true);
    expect(decide({ kind: "call", windowFocused: true, openConversation: "dm:d1" })).toBe(false);
    expect(decide({ kind: "call", settings: { notifications: false } })).toBe(false);
  });
});

const dm = (over: Partial<Message>): Message => ({
  id: "m",
  channelId: null,
  dmChannelId: "0a1b2c3d-0000-4000-8000-000000000001",
  author: { id: "u", username: "Ngọc" },
  content: "xin chào",
  createdAt: "2026-10-10T00:00:00Z",
  editedAt: null,
  seq: "1",
  attachments: [],
  ...over,
});

describe("notice builders", () => {
  it("a message: sender as title, text as body (one line, capped); a file-only message says so", () => {
    expect(messageNotice(dm({}))).toEqual({ conversationKey: "dm:0a1b2c3d-0000-4000-8000-000000000001", title: "Ngọc", body: "xin chào", kind: "message" });
    expect(messageNotice(dm({ content: "a\n\n  b" })).body).toBe("a b");
    expect(messageNotice(dm({ content: "x".repeat(500) })).body).toHaveLength(200);
    expect(messageNotice(dm({ content: "  " })).body).toBe("đã gửi một tệp");
  });
  it("a call: the caller's name and a fixed line", () => {
    expect(callNotice("d1", "Ngọc", false)).toEqual({ conversationKey: "call:d1", title: "Ngọc", body: "Cuộc gọi đến", kind: "call" });
    expect(callNotice("d1", "Ngọc", true)).toMatchObject({ body: "Cuộc gọi video đến", kind: "video-call" });
  });
  it("defaults leave notifications on", () => {
    expect(DEFAULT_SETTINGS.notifications).toBe(true);
  });
});
