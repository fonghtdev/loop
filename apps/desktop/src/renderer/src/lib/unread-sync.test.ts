import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUnreadSync, parseUnread, READ_PUT_MS } from "./unread-sync";

const CH = "channel:11111111-1111-4111-8111-111111111111" as const;
const DM = "dm:22222222-2222-4222-8222-222222222222" as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = (answer: unknown = { channels: [], dms: [] }) => {
  const calls: [string, string, unknown][] = [];
  const applied: unknown[] = [];
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push([method, path, body]);
    return method === "GET" ? answer : undefined;
  });
  const sync = createUnreadSync({ request: request as never, apply: (r) => void applied.push(r) });
  return { sync, calls, applied, request };
};
const puts = (calls: [string, string, unknown][]) => calls.filter(([m]) => m === "PUT");

describe("mark (the debounced PUT)", () => {
  it("the first report goes at once, later ones within 2 s become a single PUT with the highest seq", async () => {
    const { sync, calls } = setup();
    sync.mark(CH, "5");
    expect(puts(calls)).toEqual([["PUT", `/channels/${CH.slice(8)}/read`, { seq: "5" }]]);
    sync.mark(CH, "6");
    sync.mark(CH, "9");
    sync.mark(CH, "7");
    expect(puts(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(READ_PUT_MS);
    expect(puts(calls).map((c) => c[2])).toEqual([{ seq: "5" }, { seq: "9" }]);
    await vi.advanceTimersByTimeAsync(10 * READ_PUT_MS);
    expect(puts(calls)).toHaveLength(2);
  });

  it("each conversation has its own budget, and a DM uses its own path", () => {
    const { sync, calls } = setup();
    sync.mark(CH, "5");
    sync.mark(DM, "3");
    expect(puts(calls).map((c) => c[1])).toEqual([`/channels/${CH.slice(8)}/read`, `/dms/${DM.slice(3)}/read`]);
  });

  it("never sends a seq that is not higher than the last one sent (compared as numbers)", async () => {
    const { sync, calls } = setup();
    sync.mark(CH, "10");
    await vi.advanceTimersByTimeAsync(READ_PUT_MS);
    sync.mark(CH, "9");
    await vi.advanceTimersByTimeAsync(READ_PUT_MS);
    expect(puts(calls)).toHaveLength(1);
  });

  it("a failed PUT is repeated by the next mark of the same seq", async () => {
    const { sync, request } = setup();
    request.mockRejectedValueOnce(new Error("offline"));
    sync.mark(CH, "5");
    await vi.advanceTimersByTimeAsync(READ_PUT_MS);
    sync.mark(CH, "5");
    expect(request.mock.calls.filter(([m]) => m === "PUT")).toHaveLength(2);
  });
});

describe("refresh (GET /me/unread)", () => {
  const answer = { channels: [{ channelId: "c", guildId: "g", unread: 2, mentions: 1 }], dms: [{ dmChannelId: "d", unread: 1, mentions: 0 }] };

  it("requests close together become one, and the answer is applied", async () => {
    const { sync, calls, applied } = setup(answer);
    sync.refresh();
    sync.refresh();
    sync.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter(([m]) => m === "GET")).toHaveLength(1);
    expect(applied).toEqual([answer]);
  });

  it("minGapMs skips a refresh that follows a recent load", async () => {
    const { sync, calls } = setup(answer);
    sync.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    sync.refresh(30_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_000);
    sync.refresh(30_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
  });

  it("a refresh asked for while one is in flight runs again afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const sync = createUnreadSync({
      request: (async (m: string, p: string) => {
        calls.push(`${m} ${p}`);
        await gate;
        return { channels: [], dms: [] };
      }) as never,
      apply: () => {},
    });
    sync.refresh();
    await vi.advanceTimersByTimeAsync(500);
    sync.refresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
  });

  it("cancel (sign-out) drops a pending PUT, a pending refresh and an answer still on the way", async () => {
    const { sync, calls, applied } = setup(answer);
    sync.mark(CH, "1");
    sync.mark(CH, "2"); // waits for the window
    sync.refresh();
    sync.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([["PUT", `/channels/${CH.slice(8)}/read`, { seq: "1" }]]);
    expect(applied).toEqual([]);
  });

  it("a failing request is swallowed", async () => {
    const sync = createUnreadSync({ request: (async () => Promise.reject(new Error("down"))) as never, apply: () => {} });
    sync.refresh();
    await vi.advanceTimersByTimeAsync(1000);
  });
});

describe("parseUnread", () => {
  it("keeps well-formed rows and drops the rest", () => {
    expect(
      parseUnread({
        channels: [{ channelId: "c", guildId: "g", unread: 3, mentions: 1 }, { channelId: 5 }, null, { channelId: "x", guildId: "g", unread: -4, mentions: "no" }],
        dms: [{ dmChannelId: "d", unread: 2.9, mentions: 0 }, {}],
      }),
    ).toEqual({
      channels: [
        { channelId: "c", guildId: "g", unread: 3, mentions: 1 },
        { channelId: "x", guildId: "g", unread: 0, mentions: 0 },
      ],
      dms: [{ dmChannelId: "d", unread: 2, mentions: 0 }],
    });
    expect(parseUnread(null)).toEqual({ channels: [], dms: [] });
    expect(parseUnread({ channels: "x" })).toEqual({ channels: [], dms: [] });
  });
});
