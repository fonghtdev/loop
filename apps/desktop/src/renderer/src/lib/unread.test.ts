import { describe, expect, it } from "vitest";
import { capped, createUnread, dmTotal, DM_MARGIN_MS, parseSeen, titleWith, total, unreadOf, type UnreadStorage } from "./unread";

const UUID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const DM1 = `dm:${UUID(1)}` as const;
const DM2 = `dm:${UUID(2)}` as const;
const CH1 = `channel:${UUID(3)}` as const;
const ME = "me";
const THEM = "them";

const disk = () => {
  const data = new Map<string, string>();
  const storage: UnreadStorage = { read: (u) => data.get(u) ?? null, write: (u, v) => void data.set(u, v) };
  return { data, storage };
};
let clock = Date.parse("2026-10-10T10:00:00Z");
const msg = (id: string, seq: string, at = "2026-10-10T10:00:00Z") => ({ id, seq, createdAt: at });
const make = (d = disk()) => {
  const u = createUnread({ storage: d.storage, now: () => clock });
  u.start(ME);
  return { u, ...d, counts: () => u.store.getState().counts };
};
const count = (u: ReturnType<typeof make>["u"], key: string) => unreadOf(u.store.getState(), key);

describe("counting", () => {
  it("someone else's message in a conversation that is not being read counts, once per id", () => {
    const { u } = make();
    u.message(DM1, msg("a", "1"), THEM, ME);
    u.message(DM1, msg("a", "1"), THEM, ME); // the same message again (socket + catch-up)
    u.message(DM1, msg("b", "2"), THEM, ME);
    expect(count(u, DM1)).toBe(2);
  });

  it("our own messages never count (and mark the conversation caught up)", () => {
    const { u } = make();
    u.message(DM1, msg("a", "1"), THEM, ME);
    u.message(DM1, msg("b", "2"), ME, ME);
    expect(count(u, DM1)).toBe(0);
    u.message(DM2, msg("c", "1"), ME, ME);
    expect(count(u, DM2)).toBe(0);
  });

  it("a deleted unread message leaves no phantom count", () => {
    const { u } = make();
    u.message(DM1, msg("a", "1"), THEM, ME);
    u.message(DM1, msg("b", "2"), THEM, ME);
    u.deleted(DM1, "a");
    expect(count(u, DM1)).toBe(1);
    u.deleted(DM1, "b");
    u.deleted(DM1, "nope");
    expect(count(u, DM1)).toBe(0);
    expect(u.store.getState().counts).toEqual({});
  });

  it("a message already seen (catch-up replays it after it was read) is ignored; huge seq values compare numerically", () => {
    const { u } = make();
    u.message(CH1, msg("a", "9"), THEM, ME);
    u.message(CH1, msg("b", "10"), THEM, ME);
    u.open(CH1);
    u.setFocused(true); // read: seen = 10
    expect(count(u, CH1)).toBe(0);
    u.open(null);
    u.message(CH1, msg("a", "9"), THEM, ME);
    u.message(CH1, msg("b", "10"), THEM, ME);
    expect(count(u, CH1)).toBe(0); // "9" > "10" as strings would have counted these
    u.message(CH1, msg("big", "9007199254740993"), THEM, ME);
    u.message(CH1, msg("big2", "9007199254740994"), THEM, ME);
    expect(count(u, CH1)).toBe(2);
    u.open(CH1);
    u.message(CH1, msg("old", "9007199254740993"), THEM, ME); // < seen, still ignored after being read
    expect(count(u, CH1)).toBe(0);
  });
});

describe("reading = open + window focused + list at the bottom", () => {
  it("counts while the window is unfocused, even on the open conversation", () => {
    const { u } = make();
    u.open(DM1);
    u.setFocused(false);
    u.message(DM1, msg("a", "1"), THEM, ME);
    expect(count(u, DM1)).toBe(1);
    u.setFocused(true); // focus returns: read
    expect(count(u, DM1)).toBe(0);
  });

  it("counts while scrolled up, clears when scrolled back to the bottom", () => {
    const { u } = make();
    u.setFocused(true);
    u.open(DM1);
    u.setPinned(false);
    u.message(DM1, msg("a", "1"), THEM, ME);
    expect(count(u, DM1)).toBe(1);
    u.setPinned(true);
    expect(count(u, DM1)).toBe(0);
  });

  it("does not read a conversation that is not the open one", () => {
    const { u } = make();
    u.setFocused(true);
    u.open(DM1);
    u.message(DM2, msg("a", "1"), THEM, ME);
    expect(count(u, DM2)).toBe(1);
  });

  it("a message arriving while reading is read at once; opening clears what was counted before", () => {
    const { u } = make();
    u.setFocused(true);
    u.message(DM1, msg("a", "1"), THEM, ME);
    expect(count(u, DM1)).toBe(1);
    u.open(DM1);
    expect(count(u, DM1)).toBe(0);
    u.message(DM1, msg("b", "2"), THEM, ME);
    expect(count(u, DM1)).toBe(0);
  });

  it("observe() of loaded history is read only when reading", () => {
    const { u } = make();
    u.open(DM1);
    u.setFocused(false);
    u.observe(DM1, msg("a", "5"));
    u.message(DM1, msg("b", "6"), THEM, ME);
    expect(count(u, DM1)).toBe(1);
    u.setFocused(true);
    expect(count(u, DM1)).toBe(0);
  });
});

describe("restart detection for DMs", () => {
  const dm = (n: number, lastMessageAt: string | null) => ({ id: UUID(n), lastMessageAt });

  it("a DM with activity after what was seen is unread (a dot), within the margin it is not", () => {
    const d = disk();
    const first = make(d);
    first.u.message(DM1, msg("a", "7", "2026-10-10T09:00:00Z"), THEM, ME);
    first.u.open(DM1);
    first.u.setFocused(true); // seen up to 09:00:00
    const again = make(d); // restart
    again.u.reconcileDms([dm(1, "2026-10-10T09:00:01Z"), dm(2, null)]); // 1 s newer: inside the margin
    expect(count(again.u, DM1)).toBe(0);
    again.u.reconcileDms([dm(1, new Date(Date.parse("2026-10-10T09:00:00Z") + DM_MARGIN_MS + 1).toISOString())]);
    expect(count(again.u, DM1)).toBe(1);
    expect(again.counts()).toEqual({}); // a dot, not a count
    expect(dmTotal(again.u.store.getState())).toBe(1);
  });

  it("a DM seen for the first time is a baseline, not unread", () => {
    const { u } = make();
    u.reconcileDms([{ id: UUID(1), lastMessageAt: "2020-01-01T00:00:00Z" }]);
    expect(count(u, DM1)).toBe(0);
  });

  it("opening the DM clears the dot and it does not come back on the next list update", () => {
    const d = disk();
    const first = make(d);
    first.u.message(DM1, msg("a", "7", "2026-10-10T09:00:00Z"), THEM, ME);
    first.u.open(DM1);
    first.u.setFocused(true);
    const again = make(d);
    const list = [{ id: UUID(1), lastMessageAt: "2026-10-10T09:30:00Z" }];
    again.u.reconcileDms(list);
    expect(count(again.u, DM1)).toBe(1);
    again.u.setFocused(true);
    again.u.open(DM1);
    expect(count(again.u, DM1)).toBe(0);
    again.u.reconcileDms(list);
    expect(count(again.u, DM1)).toBe(0);
  });

  it("a live count wins over the dot (no double counting)", () => {
    const d = disk();
    const first = make(d);
    first.u.reconcileDms([{ id: UUID(1), lastMessageAt: null }]);
    const again = make(d);
    again.u.message(DM1, msg("a", "1", "2026-10-11T00:00:00Z"), THEM, ME);
    again.u.reconcileDms([{ id: UUID(1), lastMessageAt: "2026-10-11T00:00:00Z" }]);
    expect(dmTotal(again.u.store.getState())).toBe(1);
  });
});

describe("per user and sign-out", () => {
  it("marks are per user: another account sees none of them, the first gets them back", () => {
    const d = disk();
    const a = createUnread({ storage: d.storage, now: () => clock });
    a.start("A");
    a.message(DM1, msg("m", "5", "2026-10-10T09:00:00Z"), THEM, "A");
    a.setFocused(true);
    a.open(DM1);
    a.start("B");
    a.message(DM1, msg("m", "5", "2026-10-10T09:00:00Z"), THEM, "B");
    expect(count(a, DM1)).toBe(1); // B has not read it
    a.start("A");
    a.open(null);
    a.message(DM1, msg("m", "5", "2026-10-10T09:00:00Z"), THEM, "A");
    expect(count(a, DM1)).toBe(0); // A had
  });

  it("reset (sign-out) empties the counts but keeps what the user had read", () => {
    const d = disk();
    const { u } = make(d);
    u.message(DM1, msg("a", "1"), THEM, ME);
    u.reset();
    expect(u.store.getState()).toEqual({ counts: {}, dots: {} });
    expect(d.data.size).toBe(0); // nothing was read, so nothing was saved
  });

  it("corrupt or hostile stored data is dropped", () => {
    expect(parseSeen("{not json")).toEqual({});
    expect(parseSeen(JSON.stringify({ "dm:x": { seq: "1", at: 1 }, [DM1]: { seq: "-1", at: 1 }, [DM2]: { seq: "5", at: 7 } }))).toEqual({ [DM2]: { seq: "5", at: 7 } });
    expect(parseSeen(null)).toEqual({});
  });

  it("a storage that throws does not break counting", () => {
    const u = createUnread({
      storage: {
        read: () => {
          throw new Error("denied");
        },
        write: () => {
          throw new Error("denied");
        },
      },
    });
    u.start(ME);
    u.message(DM1, msg("a", "1"), THEM, ME);
    u.open(DM1);
    u.setFocused(true);
    expect(count(u, DM1)).toBe(0);
  });
});

describe("totals and labels", () => {
  it("sums DMs and channels separately, caps the badge, prefixes the title", () => {
    const { u } = make();
    for (let i = 0; i < 12; i++) u.message(DM1, msg(`d${i}`, String(i + 1)), THEM, ME);
    u.message(CH1, msg("c", "1"), THEM, ME);
    expect(dmTotal(u.store.getState())).toBe(12);
    expect(total(u.store.getState())).toBe(13);
    expect(capped(0)).toBe("");
    expect(capped(9)).toBe("9");
    expect(capped(10)).toBe("9+");
    expect(titleWith(0)).toBe("Loop");
    expect(titleWith(3)).toBe("(3) Loop");
  });
});
