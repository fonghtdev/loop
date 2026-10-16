import { describe, expect, it } from "vitest";
import { capped, createUnread, dmTotal, mentionsOf, titleWith, total, unreadOf } from "./unread";

const UUID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const DM1 = `dm:${UUID(1)}` as const;
const DM2 = `dm:${UUID(2)}` as const;
const CH1 = `channel:${UUID(3)}` as const;
const ME = "me";
const THEM = "them";

const msg = (id: string, seq: string) => ({ id, seq });
const make = () => {
  const reported: [string, string][] = [];
  const u = createUnread({ report: (key, seq) => void reported.push([key, seq]) });
  u.start();
  return { u, reported, counts: () => u.store.getState().counts };
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

describe("sign-out and the server's read pointer", () => {
  it("reset (sign-out) empties the counts", () => {
    const { u } = make();
    u.message(DM1, msg("a", "1"), THEM, ME);
    u.seed({ channels: [], dms: [{ dmChannelId: UUID(2), unread: 4, mentions: 1 }] });
    u.reset();
    expect(u.store.getState()).toEqual({ counts: {}, mentions: {}, guildMentions: {} });
  });

  it("reading tells the server how far, once per new high-water mark", () => {
    const { u, reported } = make();
    u.setFocused(true);
    u.open(DM1);
    u.observe(DM1, msg("a", "5"));
    u.observe(DM1, msg("a", "5")); // nothing new
    u.message(DM1, msg("b", "6"), THEM, ME); // arrives on screen
    u.message(DM1, msg("c", "7"), ME, ME); // our own message also counts as read
    expect(reported).toEqual([[DM1, "5"], [DM1, "6"], [DM1, "7"]]);
  });

  it("opening a conversation with unread messages reports its newest and clears the badge", () => {
    const { u, reported } = make();
    u.message(CH1, msg("a", "9"), THEM, ME);
    u.message(CH1, msg("b", "10"), THEM, ME);
    u.setFocused(true);
    u.open(CH1);
    expect(count(u, CH1)).toBe(0);
    expect(reported).toEqual([[CH1, "10"]]);
  });

  it("a message at or below what was read (catch-up replay) is ignored, compared as numbers", () => {
    const { u } = make();
    u.message(CH1, msg("a", "9"), THEM, ME);
    u.message(CH1, msg("b", "10"), THEM, ME);
    u.setFocused(true);
    u.open(CH1); // read up to 10
    u.open(null);
    u.message(CH1, msg("a", "9"), THEM, ME);
    u.message(CH1, msg("b", "10"), THEM, ME);
    expect(count(u, CH1)).toBe(0); // "9" > "10" as strings would have counted these
  });
});

describe("seeding from the server", () => {
  const G1 = UUID(40);
  const state = (u: ReturnType<typeof make>["u"]) => u.store.getState();
  const response = {
    channels: [{ channelId: UUID(3), guildId: G1, unread: 7, mentions: 2 }],
    dms: [{ dmChannelId: UUID(1), unread: 3, mentions: 0 }],
  };

  it("sets counts, mentions and the server badge for conversations that are not open, in any server", () => {
    const { u } = make();
    u.seed(response);
    expect(state(u).counts).toEqual({ [CH1]: 7, [DM1]: 3 });
    expect(state(u).mentions).toEqual({ [CH1]: 2 });
    expect(state(u).guildMentions).toEqual({ [G1]: 2 });
    expect(dmTotal(state(u))).toBe(3);
  });

  it("replaces what was counted live (the server counted it too), then live messages add on top", () => {
    const { u } = make();
    u.message(CH1, msg("a", "1"), THEM, ME, { guildId: G1 });
    u.message(DM2, msg("b", "1"), THEM, ME);
    u.seed(response);
    expect(count(u, DM2)).toBe(0); // the server said nothing is unread there
    u.message(CH1, msg("c", "2"), THEM, ME, { guildId: G1 });
    expect([count(u, CH1), mentionsOf(state(u), CH1), state(u).guildMentions[G1]]).toEqual([8, 3, 3]);
  });

  it("does not badge the conversation being read, and reading clears the server's count", () => {
    const { u } = make();
    u.setFocused(true);
    u.open(CH1);
    u.seed(response);
    expect(count(u, CH1)).toBe(0);
    expect(count(u, DM1)).toBe(3);
    u.open(DM1);
    expect(count(u, DM1)).toBe(0);
    expect(state(u).mentions).toEqual({});
  });
});

describe("read:updated from another device", () => {
  const state = (u: ReturnType<typeof make>["u"]) => u.store.getState();

  it("clears the server's count for that conversation and the live messages it covers", () => {
    const { u } = make();
    u.seed({ channels: [], dms: [{ dmChannelId: UUID(1), unread: 5, mentions: 1 }] });
    u.message(DM1, msg("a", "20"), THEM, ME);
    u.message(DM1, msg("b", "21"), THEM, ME, { guildId: null });
    u.serverRead(DM1, "20");
    expect(count(u, DM1)).toBe(1); // "21" is newer than the other device's pointer
    expect(mentionsOf(state(u), DM1)).toBe(1);
    u.serverRead(DM1, "21");
    expect(count(u, DM1)).toBe(0);
    expect(state(u).counts).toEqual({});
  });

  it("makes a later replay of a covered message harmless", () => {
    const { u } = make();
    u.serverRead(CH1, "30");
    u.message(CH1, msg("a", "30"), THEM, ME);
    expect(count(u, CH1)).toBe(0);
    u.message(CH1, msg("b", "31"), THEM, ME);
    expect(count(u, CH1)).toBe(1);
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

describe("mentions", () => {
  const G1 = UUID(40);
  const G2 = UUID(41);
  const CH2 = `channel:${UUID(4)}` as const;
  const state = (u: ReturnType<typeof make>["u"]) => u.store.getState();

  it("a message that names me counts as unread AND as a mention, per conversation and per server", () => {
    const { u } = make();
    u.message(CH1, msg("a", "1"), THEM, ME, { guildId: G1 });
    u.message(CH1, msg("b", "2"), THEM, ME); // plain
    u.message(CH2, msg("c", "1"), THEM, ME, { guildId: G2 });
    u.message(CH2, msg("d", "2"), THEM, ME, { guildId: G2 });
    expect([count(u, CH1), mentionsOf(state(u), CH1)]).toEqual([2, 1]);
    expect([count(u, CH2), mentionsOf(state(u), CH2)]).toEqual([2, 2]);
    expect(state(u).guildMentions).toEqual({ [G1]: 1, [G2]: 2 });
  });

  it("never for my own message, even one that mentions me", () => {
    const { u } = make();
    u.message(CH1, msg("a", "1"), ME, ME, { guildId: G1 });
    expect(mentionsOf(state(u), CH1)).toBe(0);
    expect(state(u).guildMentions).toEqual({});
  });

  it("the same message arriving twice (channel room and mention:new) counts once", () => {
    const { u } = make();
    u.message(CH1, msg("a", "1"), THEM, ME, { guildId: G1 });
    u.message(CH1, msg("a", "1"), THEM, ME, { guildId: G1 });
    expect([count(u, CH1), mentionsOf(state(u), CH1), state(u).guildMentions[G1]]).toEqual([1, 1, 1]);
  });

  it("reading the conversation clears its mentions and the server badge; other conversations stay", () => {
    const { u } = make();
    u.message(CH1, msg("a", "1"), THEM, ME, { guildId: G1 });
    u.message(CH2, msg("b", "1"), THEM, ME, { guildId: G1 });
    u.setFocused(true);
    u.open(CH1);
    expect(state(u).mentions).toEqual({ [CH2]: 1 });
    expect(state(u).guildMentions).toEqual({ [G1]: 1 });
  });

  it("a mention arriving while the conversation is being read is not counted", () => {
    const { u } = make();
    u.setFocused(true);
    u.open(CH1);
    u.message(CH1, msg("a", "1"), THEM, ME, { guildId: G1 });
    expect(state(u).mentions).toEqual({});
  });

  it("a deleted mention leaves no phantom badge; a mention without a known server counts only per conversation", () => {
    const { u } = make();
    u.message(CH1, msg("a", "1"), THEM, ME, { guildId: G1 });
    u.message(CH1, msg("b", "2"), THEM, ME, { guildId: null });
    expect([mentionsOf(state(u), CH1), state(u).guildMentions]).toEqual([2, { [G1]: 1 }]);
    u.deleted(CH1, "a");
    expect([mentionsOf(state(u), CH1), state(u).guildMentions]).toEqual([1, {}]);
  });

  it("sign-out forgets them", () => {
    const { u } = make();
    u.message(CH1, msg("a", "1"), THEM, ME, { guildId: G1 });
    u.reset();
    expect(state(u).mentions).toEqual({});
    expect(state(u).guildMentions).toEqual({});
  });
});

describe("a thread open beside its channel (side slot)", () => {
  const TH = `channel:${UUID(9)}` as const;
  it("reads both on screen, each with its own scroll state, and only while the window has focus", () => {
    const { u, reported } = make();
    u.setFocused(true);
    u.open(CH1);
    u.open(TH, "side");
    u.message(TH, msg("t1", "5"), THEM, ME);
    u.message(CH1, msg("c1", "6"), THEM, ME);
    expect([count(u, TH), count(u, CH1)]).toEqual([0, 0]);
    expect(reported).toEqual([[TH, "5"], [CH1, "6"]]);
    u.setPinned(false, "side"); // scrolled up in the thread: its new messages count, the channel's still do not
    u.message(TH, msg("t2", "7"), THEM, ME);
    u.message(CH1, msg("c2", "8"), THEM, ME);
    expect([count(u, TH), count(u, CH1)]).toEqual([1, 0]);
    u.setPinned(true, "side");
    expect(count(u, TH), "back at the bottom: read").toBe(0);
    u.open(null, "side");
    u.message(TH, msg("t3", "9"), THEM, ME);
    expect(count(u, TH), "closed panel: counts again").toBe(1);
  });

  it("seeds a thread's count under its own key, never under the parent channel", () => {
    const { u } = make();
    u.seed({ channels: [{ channelId: UUID(9), guildId: "g", parentChannelId: UUID(3), unread: 4, mentions: 1 }], dms: [] });
    expect([count(u, TH), count(u, CH1), mentionsOf(u.store.getState(), TH)]).toEqual([4, 0, 1]);
    expect(u.store.getState().guildMentions).toEqual({ g: 1 });
  });
});
