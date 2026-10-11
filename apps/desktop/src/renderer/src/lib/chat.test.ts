import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./auth-client";
import { channelKey, dmKey } from "./conversation";
import { createChat, fetchAllAfter, mergeMessages, PAGE_SIZE, type Message } from "./chat";

const ME = "me";
const KEY = channelKey("c1");
const text = (content: string) => ({ content, attachments: [] });
const msg = (seq: number | string, author = "other", content = `m${seq}`): Message => ({
  id: `id${seq}`,
  channelId: "c1",
  dmChannelId: null,
  attachments: [],
  author: { id: author, username: author },
  content,
  createdAt: new Date(2026, 9, 10, 12, 0, Number(seq) % 60).toISOString(),
  editedAt: null,
  seq: String(seq),
});
const seqs = (list: Message[]) => list.map((m) => m.seq);
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The real history contract (ascending, before/after/limit), ordered with BigInt so it cannot share our bug. */
function fakeServer(initial: Message[]) {
  const db = [...initial];
  const calls: string[] = [];
  let nextSeq = initial.length + 1;
  const big = (m: Message) => BigInt(m.seq);
  const request = vi.fn(async (method: string, path: string, body?: unknown): Promise<unknown> => {
    calls.push(`${method} ${path}`);
    const url = new URL(path, "http://x");
    if (method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const before = url.searchParams.get("before");
      const after = url.searchParams.get("after");
      const sorted = [...db].sort((a, b) => (big(a) < big(b) ? -1 : 1));
      if (after) return { messages: sorted.filter((m) => big(m) > BigInt(after)).slice(0, limit) };
      const older = before ? sorted.filter((m) => big(m) < BigInt(before)) : sorted;
      return { messages: older.slice(-limit) };
    }
    if (method === "POST") {
      const m = msg(nextSeq++, ME, (body as { content: string }).content);
      db.push(m);
      return m;
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const post = (m: Message) => db.push(m);
  return { request, calls, post, db };
}

function setup(initial: Message[]) {
  const server = fakeServer(initial);
  let n = 0;
  const chat = createChat({ request: server.request as never, myId: () => ME, newId: () => `tmp${++n}` });
  const state = () => chat.get(KEY);
  return { server, chat, state };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));

describe("mergeMessages", () => {
  it("dedupes by id and orders by seq numerically", () => {
    const merged = mergeMessages([msg(9), msg(10)], [msg(100), msg(9), msg(11)]);
    expect(seqs(merged)).toEqual(["9", "10", "11", "100"]);
  });

  it("keeps an edit over an older copy of the same message", () => {
    const edited = { ...msg(5), content: "new", editedAt: new Date(2026, 9, 11).toISOString() };
    expect(mergeMessages([edited], [msg(5)])[0].content).toBe("new");
    expect(mergeMessages([msg(5)], [edited])[0].content).toBe("new");
  });
});

describe("history + live", () => {
  it("loads the newest page, merges live events, pages back until the start", async () => {
    const { chat, state, server } = setup(range(1, 120));
    await chat.loadLatest(KEY);
    expect(seqs(state().messages)).toEqual(range(71, 120).map((m) => m.seq));
    expect(state().reachedStart).toBe(false);

    server.post(msg(121));
    chat.receive(KEY, { type: "message:new", message: msg(121) });
    chat.receive(KEY, { type: "message:new", message: msg(121) }); // duplicate delivery
    expect(state().messages).toHaveLength(51);

    await chat.loadOlder(KEY); // 21..70, a full page
    expect(state().reachedStart).toBe(false);
    await chat.loadOlder(KEY); // 1..20, short: the start
    expect(state().reachedStart).toBe(true);
    await chat.loadOlder(KEY); // nothing more to ask
    expect(seqs(state().messages)).toEqual(range(1, 121).map((m) => m.seq));
    expect(server.calls.filter((c) => c.includes("before="))).toEqual([
      "GET /channels/c1/messages?before=71&limit=50",
      "GET /channels/c1/messages?before=21&limit=50",
    ]);
  });

  it("a live event during the initial load is kept (merged, not overwritten)", async () => {
    const { chat, state } = setup(range(1, 10));
    const load = chat.loadLatest(KEY);
    chat.receive(KEY, { type: "message:new", message: msg(11) });
    await load;
    expect(seqs(state().messages)).toEqual(range(1, 11).map((m) => m.seq));
    expect(state().reachedStart).toBe(true);
  });

  it("applies update and delete in place; an update for an unloaded message is not added", async () => {
    const { chat, state } = setup(range(1, 3));
    await chat.loadLatest(KEY);
    chat.receive(KEY, { type: "message:update", message: { ...msg(2), content: "edited", editedAt: new Date().toISOString() } });
    chat.receive(KEY, { type: "message:delete", id: "id1" });
    chat.receive(KEY, { type: "message:update", message: msg(999) });
    expect(state().messages.map((m) => m.content)).toEqual(["edited", "m3"]);
  });
});

describe("live arrivals (the arrival animation's input)", () => {
  it("only a live message:new is marked; history pages, catch-up, edits and our own pending echo are not", async () => {
    const { chat, state, server } = setup(range(1, 80));
    await chat.loadLatest(KEY);
    expect(state().live).toEqual([]);
    await chat.loadOlder(KEY);
    expect(state().live).toEqual([]); // a history page
    for (const m of range(81, 90)) server.post(m);
    await chat.catchUp(KEY);
    expect(state().live).toEqual([]); // a catch-up
    chat.receive(KEY, { type: "message:new", message: msg(91) });
    expect(state().live).toEqual([msg(91).id]);
    chat.receive(KEY, { type: "message:new", message: msg(91) }); // the same message again: still one
    chat.receive(KEY, { type: "message:update", message: { ...msg(91), content: "edited" } });
    expect(state().live).toEqual([msg(91).id]);
  });

  it("keeps only the newest ids and a fresh load starts clean", async () => {
    const { chat, state } = setup(range(1, 5));
    await chat.loadLatest(KEY);
    for (let i = 100; i < 140; i++) chat.receive(KEY, { type: "message:new", message: msg(i) });
    expect(state().live).toHaveLength(20);
    expect(state().live.at(-1)).toBe(msg(139).id);
    await chat.loadLatest(KEY);
    expect(state().live).toEqual([]);
  });
});

describe("optimistic send", () => {
  it("shows pending at once and reconciles to exactly one message (POST answers first, echo after)", async () => {
    const { chat, state } = setup([]);
    await chat.loadLatest(KEY);
    const sending = chat.send(KEY, text("xin chào"));
    expect(state().pending).toMatchObject([{ content: "xin chào", status: "sending" }]);
    await sending;
    const sent = state().messages[0];
    chat.receive(KEY, { type: "message:new", message: sent });
    expect(state().pending).toEqual([]);
    expect(state().messages).toHaveLength(1);
  });

  it("the socket echo arriving before the POST answer never shows the message twice", async () => {
    const { chat, state, server } = setup([]);
    await chat.loadLatest(KEY);
    let release!: () => void;
    const real = server.request.getMockImplementation()!;
    server.request.mockImplementationOnce(async (...args) => {
      const m = await real(...args);
      await new Promise<void>((r) => (release = r));
      return m;
    });
    const sending = chat.send(KEY, text("hello"));
    await tick();
    const echoed = server.db[server.db.length - 1];
    chat.receive(KEY, { type: "message:new", message: echoed });
    expect(state().messages).toHaveLength(1);
    expect(state().pending).toEqual([]); // pending + echo would be two bubbles
    release();
    await sending;
    expect(state().messages).toHaveLength(1);
    expect(state().pending).toEqual([]);
  });

  it("a failed send keeps the text with failed status; retry sends it; discard removes it", async () => {
    const { chat, state, server } = setup([]);
    await chat.loadLatest(KEY);
    server.request.mockRejectedValueOnce(new ApiError(0, "/channels/c1/messages"));
    await chat.send(KEY, text("đừng mất nhé"));
    expect(state().pending).toMatchObject([{ content: "đừng mất nhé", status: "failed" }]);
    await chat.retry(KEY, state().pending[0].tempId);
    expect(state().pending).toEqual([]);
    expect(state().messages.map((m) => m.content)).toEqual(["đừng mất nhé"]);

    server.request.mockRejectedValueOnce(new ApiError(500, "/channels/c1/messages"));
    await chat.send(KEY, text("bỏ"));
    chat.discard(KEY, state().pending[0].tempId);
    expect(state().pending).toEqual([]);
  });

  it("closing a channel drops its messages but keeps unsent text", async () => {
    const { chat, state, server } = setup(range(1, 3));
    await chat.loadLatest(KEY);
    server.request.mockRejectedValueOnce(new ApiError(0, "/x"));
    await chat.send(KEY, text("nháp"));
    chat.close(KEY);
    expect(state().messages).toEqual([]);
    expect(state().pending).toHaveLength(1);
  });
});

describe("catch-up after reconnect", () => {
  it("fills the gap by paging after the last seq until a short page, with no duplicates", async () => {
    const { chat, state, server } = setup(range(1, 50));
    await chat.loadLatest(KEY);
    for (const m of range(51, 300)) server.post(m); // posted while we were offline
    chat.receive(KEY, { type: "message:new", message: msg(51) }); // one did arrive live before the drop
    await chat.catchUp(KEY);
    expect(seqs(state().messages)).toEqual(range(1, 300).map((m) => m.seq));
    expect(server.calls.filter((c) => c.includes("after="))).toEqual([
      "GET /channels/c1/messages?after=51&limit=100",
      "GET /channels/c1/messages?after=151&limit=100",
      "GET /channels/c1/messages?after=251&limit=100",
    ]);
  });

  it("waits for an initial load still in flight (its page may predate the subscription)", async () => {
    const { chat, state, server } = setup(range(1, 5));
    const load = chat.loadLatest(KEY);
    server.post(msg(6));
    await chat.catchUp(KEY);
    await load;
    expect(seqs(state().messages)).toEqual(range(1, 6).map((m) => m.seq));
  });

  it("fetchAllAfter stops on the first short page", async () => {
    const pages = [range(1, 100), range(101, 200), range(201, 230)];
    const fetchPage = vi.fn(async (_after: string, _limit: number) => pages.shift()!);
    const all = await fetchAllAfter(fetchPage, "0");
    expect(all).toHaveLength(230);
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual(["0", "100", "200"]);
  });

  it("a 404 marks the channel unavailable", async () => {
    const { chat, state, server } = setup(range(1, 3));
    server.request.mockRejectedValueOnce(new ApiError(404, "/channels/c1/messages"));
    await chat.loadLatest(KEY);
    expect(state()).toMatchObject({ status: "error", unavailable: true });
  });
});

it("PAGE_SIZE matches the server default", () => expect(PAGE_SIZE).toBe(50));

describe("one store, two kinds of conversation", () => {
  /** Channel "x" and DM "x" share an id on purpose: only the key tells them apart. */
  function twoKinds() {
    const lists: Record<string, Message[]> = { "/channels/x/messages": [msg(1, "o", "in the channel")], "/dms/x/messages": [{ ...msg(2, "o", "in the DM"), channelId: null, dmChannelId: "x" }] };
    const calls: string[] = [];
    const request = vi.fn(async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (method === "GET") return { messages: lists[path.split("?")[0]] ?? [] };
      throw new Error("unexpected");
    });
    const chat = createChat({ request: request as never, myId: () => ME });
    return { chat, calls };
  }

  it("keeps a channel and a DM with the same id apart, each with its own REST path", async () => {
    const { chat, calls } = twoKinds();
    await chat.loadLatest(channelKey("x"));
    await chat.loadLatest(dmKey("x"));
    expect(calls).toEqual(["GET /channels/x/messages?limit=50", "GET /dms/x/messages?limit=50"]);
    expect(chat.get(channelKey("x")).messages.map((m) => m.content)).toEqual(["in the channel"]);
    expect(chat.get(dmKey("x")).messages.map((m) => m.content)).toEqual(["in the DM"]);
  });

  it("an event for one never lands in the other", async () => {
    const { chat } = twoKinds();
    await chat.loadLatest(channelKey("x"));
    await chat.loadLatest(dmKey("x"));
    chat.receive(dmKey("x"), { type: "message:new", message: { ...msg(3, "o", "dm only"), channelId: null, dmChannelId: "x" } });
    chat.receive(channelKey("x"), { type: "message:delete", id: "id1" });
    expect(chat.get(dmKey("x")).messages.map((m) => m.content)).toEqual(["in the DM", "dm only"]);
    expect(chat.get(channelKey("x")).messages).toEqual([]);
  });

  it("DM messages are ordered by seq whatever the arrival order, and an echo of an old one is deduped", async () => {
    const { chat } = twoKinds();
    const k = dmKey("x");
    await chat.loadLatest(k);
    const dmMsg = (seq: number) => ({ ...msg(seq, "o"), channelId: null, dmChannelId: "x" });
    chat.receive(k, { type: "message:new", message: dmMsg(12) });
    chat.receive(k, { type: "message:new", message: dmMsg(10) });
    chat.receive(k, { type: "message:new", message: dmMsg(9) });
    chat.receive(k, { type: "message:new", message: dmMsg(10) });
    expect(chat.get(k).messages.map((m) => m.seq)).toEqual(["2", "9", "10", "12"]);
  });

  it("the sender's own DM echo never doubles the message (echo before or after the POST answer)", async () => {
    const k = dmKey("d1");
    let answer!: (m: Message) => void;
    const request = vi.fn(async (method: string) => {
      if (method === "GET") return { messages: [] };
      return new Promise<Message>((r) => (answer = r));
    });
    const chat = createChat({ request: request as never, myId: () => ME });
    await chat.loadLatest(k);
    const sending = chat.send(k, text("chào"));
    const mine: Message = { ...msg(5, ME, "chào"), channelId: null, dmChannelId: "d1" };
    chat.receive(k, { type: "message:new", message: mine }); // echo first
    expect(chat.get(k).pending).toEqual([]); // already one bubble, not pending + echo
    expect(chat.get(k).messages).toHaveLength(1);
    answer(mine);
    await sending;
    chat.receive(k, { type: "message:new", message: mine }); // a duplicate delivery
    expect(chat.get(k).messages).toHaveLength(1);
    expect(chat.get(k).pending).toEqual([]);
  });

  it("DM catch-up pages with `after` until a short page, exactly once each", async () => {
    const k = dmKey("d1");
    const all = Array.from({ length: 230 }, (_, i) => ({ ...msg(i + 1), channelId: null, dmChannelId: "d1" }));
    const queries: string[] = [];
    const request = vi.fn(async (_m: string, path: string) => {
      const url = new URL(path, "http://x");
      queries.push(url.pathname + url.search);
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit"));
      if (after) return { messages: all.filter((m) => BigInt(m.seq) > BigInt(after)).slice(0, limit) };
      return { messages: all.slice(0, 50) }; // an old window: the first 50
    });
    const chat = createChat({ request: request as never, myId: () => ME });
    await chat.loadLatest(k);
    await chat.catchUp(k);
    expect(queries.slice(1)).toEqual(["/dms/d1/messages?after=50&limit=100", "/dms/d1/messages?after=150&limit=100"]); // 100, then a short page of 80: done
    expect(chat.get(k).messages.map((m) => m.seq)).toEqual(all.map((m) => m.seq));
  });
});

describe("messages with attachments", () => {
  const file = { id: "a1", filename: "anh.png", contentType: "image/png", size: 100, previewUrl: "blob:local" };
  const serverMsg = (over: Partial<Message> = {}): Message => ({
    ...msg(7, ME, ""),
    attachments: [{ id: "a1", filename: "anh.png", contentType: "image/png", size: 100, url: "http://s3/a1" }],
    ...over,
  });

  it("sends attachmentIds, shows the local preview as pending, then reconciles to the server message", async () => {
    let body: unknown;
    const request = vi.fn(async (method: string, _p: string, b?: unknown) => {
      if (method === "GET") return { messages: [] };
      body = b;
      return serverMsg();
    });
    const chat = createChat({ request: request as never, myId: () => ME });
    await chat.loadLatest(KEY);
    const sending = chat.send(KEY, { content: "", attachments: [file] });
    expect(chat.get(KEY).pending[0].attachments).toEqual([file]);
    await sending;
    expect(body).toEqual({ content: "", attachmentIds: ["a1"] });
    expect(chat.get(KEY).pending).toEqual([]);
    expect(chat.get(KEY).messages[0].attachments[0].url).toBe("http://s3/a1");
  });

  it("a text-only message does not send attachmentIds", async () => {
    let body: unknown;
    const request = vi.fn(async (method: string, _p: string, b?: unknown) => {
      if (method === "GET") return { messages: [] };
      body = b;
      return serverMsg({ content: "x", attachments: [] });
    });
    const chat = createChat({ request: request as never, myId: () => ME });
    await chat.loadLatest(KEY);
    await chat.send(KEY, text("x"));
    expect(body).toEqual({ content: "x" });
  });

  it("the echo (same text, same attachment ids) replaces the pending one: never two bubbles", async () => {
    const request = vi.fn(async (method: string) => (method === "GET" ? { messages: [] } : new Promise(() => {})));
    const chat = createChat({ request: request as never, myId: () => ME });
    await chat.loadLatest(KEY);
    void chat.send(KEY, { content: "", attachments: [file] });
    chat.receive(KEY, { type: "message:new", message: serverMsg() });
    expect(chat.get(KEY).pending).toEqual([]);
    expect(chat.get(KEY).messages).toHaveLength(1);
    chat.receive(KEY, { type: "message:new", message: serverMsg() });
    expect(chat.get(KEY).messages).toHaveLength(1);
  });

  it("a message with other attachments does not swallow a pending one", async () => {
    const request = vi.fn(async (method: string) => (method === "GET" ? { messages: [] } : new Promise(() => {})));
    const chat = createChat({ request: request as never, myId: () => ME });
    await chat.loadLatest(KEY);
    void chat.send(KEY, { content: "", attachments: [file] });
    chat.receive(KEY, { type: "message:new", message: serverMsg({ attachments: [{ id: "other", filename: "x", contentType: "image/png", size: 1, url: "u" }] }) });
    expect(chat.get(KEY).pending).toHaveLength(1);
  });

  it("a failed send keeps the files for retry, which sends the same ids", async () => {
    const bodies: unknown[] = [];
    let fail = true;
    const request = vi.fn(async (method: string, _p: string, b?: unknown) => {
      if (method === "GET") return { messages: [] };
      bodies.push(b);
      if (fail) throw new ApiError(0, "/x");
      return serverMsg();
    });
    const chat = createChat({ request: request as never, myId: () => ME });
    await chat.loadLatest(KEY);
    await chat.send(KEY, { content: "kèm ảnh", attachments: [file] });
    expect(chat.get(KEY).pending).toMatchObject([{ status: "failed", content: "kèm ảnh", attachments: [file] }]);
    fail = false;
    await chat.retry(KEY, chat.get(KEY).pending[0].tempId);
    expect(bodies).toEqual([{ content: "kèm ảnh", attachmentIds: ["a1"] }, { content: "kèm ảnh", attachmentIds: ["a1"] }]);
    expect(chat.get(KEY).pending).toEqual([]);
  });
});

describe("a DM send refused with 403 Not friends", () => {
  it("keeps the text (failed, retry/discard), marks the conversation, and tells the app the friends list is stale", async () => {
    const k = dmKey("d1");
    const onForbidden = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method === "GET") return { messages: [] };
      throw new ApiError(403, "/dms/d1/messages", "Not friends");
    });
    const chat = createChat({ request: request as never, myId: () => ME, onForbidden });
    await chat.loadLatest(k);
    await chat.send(k, text("còn đó không"));
    expect(chat.get(k).pending).toMatchObject([{ content: "còn đó không", status: "failed" }]);
    expect(chat.get(k).forbiddenAt).toEqual(expect.any(Number));
    expect(onForbidden).toHaveBeenCalledTimes(1);
    expect(chat.get(k).unavailable).toBe(false); // history stays readable
  });
  it("a 403 in a channel is not a friendship matter", async () => {
    const onForbidden = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method === "GET") return { messages: [] };
      throw new ApiError(403, "/channels/c1/messages");
    });
    const chat = createChat({ request: request as never, myId: () => ME, onForbidden });
    await chat.loadLatest(KEY);
    await chat.send(KEY, text("x"));
    expect(onForbidden).not.toHaveBeenCalled();
    expect(chat.get(KEY).forbiddenAt).toBeNull();
  });
});

describe("onSent (the checklist's first-message step)", () => {
  it("fires when the server accepts a message, and not when the send fails", async () => {
    const onSent = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method === "GET") return { messages: [] };
      if (request.mock.calls.filter((c) => c[0] === "POST").length === 1) throw new ApiError(500, "/channels/c1/messages");
      return msg(1, ME, "ok");
    });
    const chat = createChat({ request: request as never, myId: () => ME, onSent });
    await chat.loadLatest(KEY);
    await chat.send(KEY, text("hỏng"));
    expect(onSent).not.toHaveBeenCalled();
    await chat.retry(KEY, chat.get(KEY).pending[0].tempId);
    expect(onSent).toHaveBeenCalledTimes(1);
  });
});
