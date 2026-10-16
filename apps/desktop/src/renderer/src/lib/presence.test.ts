import { describe, expect, it, vi } from "vitest";
import { asPref, asStatus, createPresence, dotOfPref, shownStatus, statusShownFor, statusLabel, statusRows } from "./presence";

const make = (request = vi.fn()) => ({ request, p: createPresence({ request: request as never }) });
const byUser = (p: ReturnType<typeof make>["p"]) => p.store.getState().byUser;

describe("presence store", () => {
  it("seeds from lists, keeps them live, and treats the unknown as offline", () => {
    const { p } = make();
    expect(p.seed([{ id: "a", status: "idle" }, { id: "b" }], "list")).toBe("list");
    expect(byUser(p)).toEqual({ a: "idle", b: "offline" });
    p.apply({ type: "presence", userId: "a", status: "dnd" });
    p.apply({ type: "dm:new", dm: { id: "d", user: { id: "c", username: "c", status: "online" } } });
    p.apply({ type: "friend:request", from: { id: "z", username: "z" } });
    expect(byUser(p)).toEqual({ a: "dnd", b: "offline", c: "online" });
    expect(shownStatus(byUser(p), "nobody", new Set())).toBe("offline");
  });

  it("a bogus server value reads as offline", () => {
    expect(asStatus("away")).toBe("offline");
    expect(asStatus(undefined)).toBe("offline");
    expect(asPref("offline")).toBeNull();
    expect(asPref("invisible")).toBe("invisible");
  });

  it("shows offline for the blocked and until the block list is known", () => {
    const m = { a: "online", b: "idle" } as const;
    expect(shownStatus(m, "a", new Set(["a"]))).toBe("offline");
    expect(shownStatus(m, "b", new Set(["a"]))).toBe("idle");
    expect(shownStatus(m, "b", null)).toBe("offline");
  });

  it("clear forgets everyone and the own choice (no leaking between accounts)", () => {
    const { p } = make();
    p.seed([{ id: "a", status: "online" }], 0);
    p.setMine("dnd");
    p.clear();
    expect(p.store.getState()).toEqual({ byUser: {}, mine: "online" });
  });

  it("loads the own choice, ignoring a failed or invalid answer", async () => {
    const { p, request } = make(vi.fn().mockResolvedValueOnce({ status: "invisible" }).mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({ status: "weird" }));
    await p.loadMine();
    expect(p.store.getState().mine).toBe("invisible");
    await p.loadMine();
    await p.loadMine();
    expect(p.store.getState().mine).toBe("invisible");
    expect(request).toHaveBeenCalledWith("GET", "/me/status");
  });

  it("choose shows at once, sends PUT, and rolls back (rethrowing) when refused", async () => {
    let fail!: (e: Error) => void;
    const { p, request } = make(vi.fn(() => new Promise((_, rej) => (fail = rej))));
    const done = p.choose("dnd");
    expect(p.store.getState().mine).toBe("dnd");
    expect(request).toHaveBeenCalledWith("PUT", "/me/status", { status: "dnd" });
    fail(new Error("no"));
    await expect(done).rejects.toThrow("no");
    expect(p.store.getState().mine).toBe("online");
  });

  it("a rollback does not undo a newer choice made meanwhile (me:status from another device)", async () => {
    let fail!: (e: Error) => void;
    const { p } = make(vi.fn(() => new Promise((_, rej) => (fail = rej))));
    const done = p.choose("dnd");
    p.setMine("idle");
    fail(new Error("no"));
    await expect(done).rejects.toThrow();
    expect(p.store.getState().mine).toBe("idle");
  });
});

describe("status model", () => {
  it("labels the four statuses", () => {
    expect((["online", "idle", "dnd", "offline"] as const).map(statusLabel)).toEqual(["Trực tuyến", "Vắng mặt", "Không làm phiền", "Ngoại tuyến"]);
  });

  it("invisible looks like the offline ring to its owner", () => {
    expect(dotOfPref("invisible")).toBe("offline");
    expect((["online", "idle", "dnd"] as const).map(dotOfPref)).toEqual(["online", "idle", "dnd"]);
  });

  it("the picker has four rows, marks the current one, and explains only dnd and invisible", () => {
    const rows = statusRows("idle");
    expect(rows.map((r) => [r.pref, r.dot, r.label, r.selected])).toEqual([
      ["online", "online", "Trực tuyến", false],
      ["idle", "idle", "Vắng mặt", true],
      ["dnd", "dnd", "Không làm phiền", false],
      ["invisible", "offline", "Ẩn", false],
    ]);
    expect(rows.map((r) => r.description)).toEqual([undefined, undefined, "Bạn sẽ không nhận thông báo trên máy này", "Bạn sẽ hiện là ngoại tuyến với mọi người"]);
  });
});

describe("statusShownFor", () => {
  const known = { me: "online", you: "idle" } as const;
  it("shows our own choice, not the stale pushed value; invisible is offline", () => {
    expect(statusShownFor(known, "me", new Set(), { id: "me", pref: "invisible" })).toBe("offline");
    expect(statusShownFor(known, "me", new Set(), { id: "me", pref: "dnd" })).toBe("dnd");
  });
  it("leaves everyone else to the pushed status", () => {
    expect(statusShownFor(known, "you", new Set(), { id: "me", pref: "invisible" })).toBe("idle");
  });
});
