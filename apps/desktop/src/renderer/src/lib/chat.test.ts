import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./auth-client";
import { createChat, fetchAllAfter, mergeMessages, PAGE_SIZE, type Message } from "./chat";

const ME = "me";
const msg = (seq: number | string, author = "other", content = `m${seq}`): Message => ({
  id: `id${seq}`,
  channelId: "c1",
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
  const state = () => chat.get("c1");
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
    await chat.loadLatest("c1");
    expect(seqs(state().messages)).toEqual(range(71, 120).map((m) => m.seq));
    expect(state().reachedStart).toBe(false);

    server.post(msg(121));
    chat.receive("c1", { type: "message:new", message: msg(121) });
    chat.receive("c1", { type: "message:new", message: msg(121) }); // duplicate delivery
    expect(state().messages).toHaveLength(51);

    await chat.loadOlder("c1"); // 21..70, a full page
    expect(state().reachedStart).toBe(false);
    await chat.loadOlder("c1"); // 1..20, short: the start
    expect(state().reachedStart).toBe(true);
    await chat.loadOlder("c1"); // nothing more to ask
    expect(seqs(state().messages)).toEqual(range(1, 121).map((m) => m.seq));
    expect(server.calls.filter((c) => c.includes("before="))).toEqual([
      "GET /channels/c1/messages?before=71&limit=50",
      "GET /channels/c1/messages?before=21&limit=50",
    ]);
  });

  it("a live event during the initial load is kept (merged, not overwritten)", async () => {
    const { chat, state } = setup(range(1, 10));
    const load = chat.loadLatest("c1");
    chat.receive("c1", { type: "message:new", message: msg(11) });
    await load;
    expect(seqs(state().messages)).toEqual(range(1, 11).map((m) => m.seq));
    expect(state().reachedStart).toBe(true);
  });

  it("applies update and delete in place; an update for an unloaded message is not added", async () => {
    const { chat, state } = setup(range(1, 3));
    await chat.loadLatest("c1");
    chat.receive("c1", { type: "message:update", message: { ...msg(2), content: "edited", editedAt: new Date().toISOString() } });
    chat.receive("c1", { type: "message:delete", id: "id1" });
    chat.receive("c1", { type: "message:update", message: msg(999) });
    expect(state().messages.map((m) => m.content)).toEqual(["edited", "m3"]);
  });
});

describe("optimistic send", () => {
  it("shows pending at once and reconciles to exactly one message (POST answers first, echo after)", async () => {
    const { chat, state } = setup([]);
    await chat.loadLatest("c1");
    const sending = chat.send("c1", "xin chào");
    expect(state().pending).toMatchObject([{ content: "xin chào", status: "sending" }]);
    await sending;
    const sent = state().messages[0];
    chat.receive("c1", { type: "message:new", message: sent });
    expect(state().pending).toEqual([]);
    expect(state().messages).toHaveLength(1);
  });

  it("the socket echo arriving before the POST answer never shows the message twice", async () => {
    const { chat, state, server } = setup([]);
    await chat.loadLatest("c1");
    let release!: () => void;
    const real = server.request.getMockImplementation()!;
    server.request.mockImplementationOnce(async (...args) => {
      const m = await real(...args);
      await new Promise<void>((r) => (release = r));
      return m;
    });
    const sending = chat.send("c1", "hello");
    await tick();
    const echoed = server.db[server.db.length - 1];
    chat.receive("c1", { type: "message:new", message: echoed });
    expect(state().messages).toHaveLength(1);
    expect(state().pending).toEqual([]); // pending + echo would be two bubbles
    release();
    await sending;
    expect(state().messages).toHaveLength(1);
    expect(state().pending).toEqual([]);
  });

  it("a failed send keeps the text with failed status; retry sends it; discard removes it", async () => {
    const { chat, state, server } = setup([]);
    await chat.loadLatest("c1");
    server.request.mockRejectedValueOnce(new ApiError(0, "/channels/c1/messages"));
    await chat.send("c1", "đừng mất nhé");
    expect(state().pending).toMatchObject([{ content: "đừng mất nhé", status: "failed" }]);
    await chat.retry("c1", state().pending[0].tempId);
    expect(state().pending).toEqual([]);
    expect(state().messages.map((m) => m.content)).toEqual(["đừng mất nhé"]);

    server.request.mockRejectedValueOnce(new ApiError(500, "/channels/c1/messages"));
    await chat.send("c1", "bỏ");
    chat.discard("c1", state().pending[0].tempId);
    expect(state().pending).toEqual([]);
  });

  it("closing a channel drops its messages but keeps unsent text", async () => {
    const { chat, state, server } = setup(range(1, 3));
    await chat.loadLatest("c1");
    server.request.mockRejectedValueOnce(new ApiError(0, "/x"));
    await chat.send("c1", "nháp");
    chat.close("c1");
    expect(state().messages).toEqual([]);
    expect(state().pending).toHaveLength(1);
  });
});

describe("catch-up after reconnect", () => {
  it("fills the gap by paging after the last seq until a short page, with no duplicates", async () => {
    const { chat, state, server } = setup(range(1, 50));
    await chat.loadLatest("c1");
    for (const m of range(51, 300)) server.post(m); // posted while we were offline
    chat.receive("c1", { type: "message:new", message: msg(51) }); // one did arrive live before the drop
    await chat.catchUp("c1");
    expect(seqs(state().messages)).toEqual(range(1, 300).map((m) => m.seq));
    expect(server.calls.filter((c) => c.includes("after="))).toEqual([
      "GET /channels/c1/messages?after=51&limit=100",
      "GET /channels/c1/messages?after=151&limit=100",
      "GET /channels/c1/messages?after=251&limit=100",
    ]);
  });

  it("waits for an initial load still in flight (its page may predate the subscription)", async () => {
    const { chat, state, server } = setup(range(1, 5));
    const load = chat.loadLatest("c1");
    server.post(msg(6));
    await chat.catchUp("c1");
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
    await chat.loadLatest("c1");
    expect(state()).toMatchObject({ status: "error", unavailable: true });
  });
});

it("PAGE_SIZE matches the server default", () => expect(PAGE_SIZE).toBe(50));
