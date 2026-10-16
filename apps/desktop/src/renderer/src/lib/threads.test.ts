import { QueryClient } from "@tanstack/react-query";
import { Permission as P } from "@loop/shared";
import { describe, expect, it } from "vitest";
import { applyStarter, type Message } from "./chat";
import { channelKey, messagesPath, uploadTarget } from "./conversation";
import { applyThreadEvent, canStartThread, createThreadPanel, reduceThreadList, sortThreads, starterUpdate, suggestName, threadChip, threadRights, threadsKey, threadsPath, type Thread } from "./threads";

const thread = (id: string, over: Partial<Thread> = {}): Thread => ({
  id,
  guildId: "g1",
  parentChannelId: "c1",
  name: id,
  starterMessageId: `m-${id}`,
  createdById: "creator",
  createdAt: "2026-10-10T10:00:00.000Z",
  lastMessageAt: "2026-10-10T10:00:00.000Z",
  archived: false,
  messageCount: 0,
  ...over,
});

describe("thread conversation key", () => {
  it("is the channel key of the thread id: same REST path, same upload target, same unread key as the server's channelId", () => {
    expect(channelKey("t1")).toBe("channel:t1");
    expect(messagesPath(channelKey("t1"))).toBe("/channels/t1/messages");
    expect(uploadTarget(channelKey("t1"))).toEqual({ channelId: "t1" });
    expect(threadsPath("c1", false)).toBe("/channels/c1/threads");
    expect(threadsPath("c1", true)).toBe("/channels/c1/threads?archived=true");
  });
});

describe("thread lists", () => {
  it("orders newest activity first", () => {
    const a = thread("a", { lastMessageAt: "2026-10-10T12:00:00.000Z" });
    const b = thread("b", { lastMessageAt: "2026-10-10T11:00:00.000Z" });
    const c = thread("c", { lastMessageAt: null, createdAt: "2026-10-10T13:00:00.000Z" });
    expect(sortThreads([b, a, c]).map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("puts a thread in the list that matches its archived flag, moves it on archive, drops it on delete, idempotently", () => {
    const old = thread("old", { lastMessageAt: "2026-10-09T00:00:00.000Z" });
    const t = thread("t");
    const created = { type: "thread:created" as const, thread: t };
    const active = reduceThreadList([old], created, false);
    expect(active.map((x) => x.id)).toEqual(["t", "old"]);
    expect(reduceThreadList(active, created, false), "echo: no change").toEqual(active);
    expect(reduceThreadList([], created, true), "not archived: not in the archived list").toEqual([]);
    const archived = { type: "thread:updated" as const, thread: { ...t, archived: true } };
    expect(reduceThreadList(active, archived, false).map((x) => x.id)).toEqual(["old"]);
    expect(reduceThreadList([], archived, true).map((x) => x.id)).toEqual(["t"]);
    const gone = { type: "thread:deleted" as const, gone: { id: "t", guildId: "g1", parentChannelId: "c1", starterMessageId: "m-t" } };
    expect(reduceThreadList(active, gone, false).map((x) => x.id)).toEqual(["old"]);
    const untouched = [old];
    expect(reduceThreadList(untouched, gone, false), "same array when nothing changes").toBe(untouched);
  });

  it("updates both cached lists of the thread's channel and leaves unfetched lists unfetched", () => {
    const qc = new QueryClient();
    qc.setQueryData(threadsKey("c1", false), [thread("t")]);
    qc.setQueryData(threadsKey("c1", true), []);
    applyThreadEvent(qc, { type: "thread:updated", thread: thread("t", { archived: true, name: "renamed" }) });
    expect(qc.getQueryData(threadsKey("c1", false))).toEqual([]);
    expect(qc.getQueryData<Thread[]>(threadsKey("c1", true))!.map((t) => t.name)).toEqual(["renamed"]);
    applyThreadEvent(qc, { type: "thread:created", thread: thread("x", { parentChannelId: "c2" }) });
    expect(qc.getQueryData(threadsKey("c2", false))).toBeUndefined();
  });

  it("updates the starter message's thread (and clears it on delete), only for that message", () => {
    const m = (id: string): Message => ({ id, channelId: "c1", dmChannelId: null, author: { id: "u", username: "u" }, content: "x", createdAt: "", editedAt: null, seq: "1", attachments: [], thread: null });
    const list = [m("m-t"), m("other")];
    const t = thread("t", { messageCount: 3 });
    const up = starterUpdate({ type: "thread:updated", thread: t });
    expect(up).toEqual({ messageId: "m-t", thread: t });
    const next = applyStarter(list, up.messageId!, up.thread);
    expect(next.map((x) => x.thread?.messageCount ?? null)).toEqual([3, null]);
    expect(next[1]).toBe(list[1]);
    const gone = starterUpdate({ type: "thread:deleted", gone: { id: "t", guildId: "g1", parentChannelId: "c1", starterMessageId: "m-t" } });
    expect(applyStarter(next, gone.messageId!, gone.thread)[0]!.thread).toBeNull();
    expect(applyStarter(list, "not-loaded", t), "a starter outside the loaded window: nothing to do").toBe(list);
  });
});

describe("who may do what in a thread (parent's bits)", () => {
  const SEND = P.VIEW_CHANNEL | P.SEND_MESSAGES;
  it("lets the creator or a moderator manage it, and anyone with SEND post unless it is archived", () => {
    const t = thread("t");
    expect(threadRights(SEND, t, "creator")).toEqual({ manage: true, post: true });
    expect(threadRights(SEND, t, "someone")).toEqual({ manage: false, post: true });
    expect(threadRights(SEND | P.MANAGE_MESSAGES, t, "someone").manage).toBe(true);
    expect(threadRights(P.VIEW_CHANNEL, t, "someone").post, "no SEND in the parent").toBe(false);
    expect(threadRights(SEND, { ...t, archived: true }, "creator")).toEqual({ manage: true, post: false });
    expect(threadRights(SEND, { ...t, createdById: null }, undefined).manage, "an unknown creator is nobody").toBe(false);
  });

  it("offers 'Tạo luồng' only in a channel, on a message without a thread, to someone who may write", () => {
    expect(canStartThread({ inThread: false, hasThread: false, canSend: true })).toBe(true);
    expect(canStartThread({ inThread: true, hasThread: false, canSend: true })).toBe(false);
    expect(canStartThread({ inThread: false, hasThread: true, canSend: true })).toBe(false);
    expect(canStartThread({ inThread: false, hasThread: false, canSend: false })).toBe(false);
  });
});

describe("the starter's chip", () => {
  const now = new Date("2026-10-10T15:00:00");
  it("counts replies and shows the time of the last activity (a date before today)", () => {
    expect(threadChip({ messageCount: 3, lastMessageAt: new Date("2026-10-10T14:05:00").toISOString(), createdAt: "" }, now)).toEqual({ key: "thread.chip", vars: { count: "3", time: "14:05" } });
    expect(threadChip({ messageCount: 1, lastMessageAt: new Date("2026-10-02T09:00:00").toISOString(), createdAt: "" }, now).vars.time).toBe("2/10");
    expect(threadChip({ messageCount: 0, lastMessageAt: null, createdAt: new Date("2026-10-10T08:30:00").toISOString() }, now)).toEqual({ key: "thread.chipEmpty", vars: { time: "08:30" } });
  });

  it("suggests a name from the starter's first line, cut at 40 characters", () => {
    expect(suggestName("\n  hello there \nsecond", "Luồng")).toBe("hello there");
    expect(suggestName("a".repeat(45), "Luồng")).toBe(`${"a".repeat(40)}…`);
    expect(suggestName("", "Luồng")).toBe("Luồng");
  });
});

describe("the side panel", () => {
  it("opens one thread, follows its live changes, closes on delete (saying so) and when the channel changes", () => {
    const panel = createThreadPanel();
    panel.open(thread("t"));
    expect(panel.apply({ type: "thread:updated", thread: thread("other", { name: "x" }) })).toBeNull();
    expect(panel.store.getState().thread!.name).toBe("t");
    panel.apply({ type: "thread:updated", thread: thread("t", { archived: true }) });
    expect(panel.store.getState().thread!.archived).toBe(true);
    expect(panel.apply({ type: "thread:deleted", gone: { id: "t", guildId: "g1", parentChannelId: "c1", starterMessageId: null } })).toBe("deleted");
    expect(panel.store.getState().thread).toBeNull();
    panel.open(thread("t"));
    panel.follow("c1");
    expect(panel.store.getState().thread, "same channel: stays").not.toBeNull();
    panel.follow("c2");
    expect(panel.store.getState().thread).toBeNull();
    panel.open(thread("t"));
    panel.follow(null);
    expect(panel.store.getState().thread).toBeNull();
  });
});
