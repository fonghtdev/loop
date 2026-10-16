import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTyping, createTypingSender, TYPING_EXPIRE_MS, TYPING_SEND_MS, typingText } from "./typing";

const CH = "channel:11111111-1111-4111-8111-111111111111" as const;
const DM = "dm:22222222-2222-4222-8222-222222222222" as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const typers = (t: ReturnType<typeof createTyping>, key: string) => t.store.getState().typers[key] ?? [];

describe("who is typing", () => {
  it("lists typers in the order they started, once each, per conversation", () => {
    const t = createTyping();
    t.receive(CH, "a");
    t.receive(CH, "b");
    t.receive(CH, "a");
    t.receive(DM, "c");
    expect(typers(t, CH)).toEqual(["a", "b"]);
    expect(typers(t, DM)).toEqual(["c"]);
  });

  it("each entry expires 8 s after its last event", () => {
    const t = createTyping();
    t.receive(CH, "a");
    vi.advanceTimersByTime(TYPING_EXPIRE_MS - 1);
    t.receive(CH, "a"); // still typing: the clock restarts
    vi.advanceTimersByTime(TYPING_EXPIRE_MS - 1);
    expect(typers(t, CH)).toEqual(["a"]);
    vi.advanceTimersByTime(1);
    expect(typers(t, CH)).toEqual([]);
    expect(t.store.getState().typers).toEqual({}); // no empty lists left behind
  });

  it("one person expiring does not touch the others", () => {
    const t = createTyping();
    t.receive(CH, "a");
    vi.advanceTimersByTime(5000);
    t.receive(CH, "b");
    vi.advanceTimersByTime(3000);
    expect(typers(t, CH)).toEqual(["b"]);
  });

  it("stop() (their message arrived) removes them at once and cancels the timer", () => {
    const t = createTyping();
    t.receive(CH, "a");
    t.receive(CH, "b");
    t.stop(CH, "a");
    expect(typers(t, CH)).toEqual(["b"]);
    t.stop(CH, "nobody");
    vi.advanceTimersByTime(TYPING_EXPIRE_MS);
    expect(t.store.getState().typers).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reset() forgets everything and leaves no timer", () => {
    const t = createTyping();
    t.receive(CH, "a");
    t.reset();
    expect(t.store.getState().typers).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the line", () => {
  it("names one or two people, then says many; nobody gives an empty line", () => {
    expect(typingText([])).toBe("");
    expect(typingText(["An"])).toBe("An đang gõ...");
    expect(typingText(["An", "Bình"])).toBe("An và Bình đang gõ...");
    expect(typingText(["An", "Bình", "Chi"])).toBe("Nhiều người đang gõ...");
  });
});

describe("announcing our own typing", () => {
  it("never for an empty draft, and at most once per 5 s per conversation while typing", () => {
    const sent: string[] = [];
    const s = createTypingSender({ send: (k) => void sent.push(k) });
    s.draftChanged(CH, "");
    s.draftChanged(CH, "   ");
    expect(sent).toEqual([]);
    s.draftChanged(CH, "h");
    s.draftChanged(CH, "he");
    vi.advanceTimersByTime(TYPING_SEND_MS - 1);
    s.draftChanged(CH, "hel");
    expect(sent).toEqual([CH]);
    vi.advanceTimersByTime(1);
    s.draftChanged(CH, "hell");
    s.draftChanged(DM, "x");
    expect(sent).toEqual([CH, CH, DM]);
  });

  it("sending a message forgets the timer: the next draft announces itself at once", () => {
    const sent: string[] = [];
    const s = createTypingSender({ send: (k) => void sent.push(k) });
    s.draftChanged(CH, "hi");
    s.sent(CH);
    s.draftChanged(CH, "again");
    expect(sent).toEqual([CH, CH]);
  });
});
