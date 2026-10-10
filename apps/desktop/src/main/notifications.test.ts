import { describe, expect, it, vi } from "vitest";
import { BODY_MAX, createNotifier, GENERIC_BODY, parseNotify, presentable, TITLE_MAX } from "./notifications";

const ID = "0a1b2c3d-0000-4000-8000-000000000001";
const ok = { conversationKey: `dm:${ID}`, title: "Ngọc", body: "xin chào", kind: "message" as const };

describe("parseNotify (what the renderer may ask the OS to show)", () => {
  it("accepts a well-formed message and call", () => {
    expect(parseNotify(ok)).toEqual(ok);
    expect(parseNotify({ conversationKey: `call:${ID}`, title: "Ngọc", body: "Cuộc gọi đến", kind: "call" })).not.toBeNull();
    expect(parseNotify({ conversationKey: `call:${ID}`, title: "Ngọc", body: "x", kind: "video-call" })).not.toBeNull();
  });

  it.each([
    ["not an object", "x"],
    ["null", null],
    ["an array", [ok]],
    ["bad key", { ...ok, conversationKey: "dm:../../etc" }],
    ["a key with a path", { ...ok, conversationKey: `dm:${ID}/x` }],
    ["another prefix", { ...ok, conversationKey: `user:${ID}` }],
    ["a message with a call key", { ...ok, conversationKey: `call:${ID}` }],
    ["a call with a conversation key", { ...ok, kind: "call" }],
    ["unknown kind", { ...ok, kind: "alert" }],
    ["missing title", { ...ok, title: undefined }],
    ["non-string body", { ...ok, body: 5 }],
    ["empty title", { ...ok, title: "  \n " }],
    ["title over the cap", { ...ok, title: "a".repeat(TITLE_MAX + 1) }],
    ["body over the cap", { ...ok, body: "a".repeat(BODY_MAX + 1) }],
  ])("refuses %s", (_name, raw) => {
    expect(parseNotify(raw)).toBeNull();
  });

  it("takes exactly the caps, and turns control characters and bidi overrides into spaces (plain text only)", () => {
    expect(parseNotify({ ...ok, title: "a".repeat(TITLE_MAX), body: "b".repeat(BODY_MAX) })).not.toBeNull();
    expect(parseNotify({ ...ok, body: "dòng 1\ndòng 2‮abc\u0000" })?.body).toBe("dòng 1 dòng 2 abc");
    expect(parseNotify({ ...ok, body: "<b>bold</b> &amp;" })?.body).toBe("<b>bold</b> &amp;"); // not interpreted: the OS shows it as text
  });
});

describe("presentable (what is shown)", () => {
  const p = parseNotify(ok)!;
  it("shows the text when previews are on", () => {
    expect(presentable(p, { notifications: true, preview: true })).toEqual({ title: "Ngọc", body: "xin chào" });
  });
  it("preview off: only the sender and a generic line, the message text never leaves", () => {
    const shown = presentable(p, { notifications: true, preview: false });
    expect(shown).toEqual({ title: "Ngọc", body: GENERIC_BODY });
    expect(JSON.stringify(shown)).not.toContain("xin chào");
  });
  it("preview off does not blank a call (nothing private in it)", () => {
    const call = parseNotify({ conversationKey: `call:${ID}`, title: "Ngọc", body: "Cuộc gọi đến", kind: "call" })!;
    expect(presentable(call, { notifications: true, preview: false })?.body).toBe("Cuộc gọi đến");
  });
  it("notifications off: nothing", () => {
    expect(presentable(p, { notifications: false, preview: true })).toBeNull();
  });
});

function fakeNotification() {
  const made: { opts: { title: string; body: string; silent: boolean }; shown: boolean; closed: boolean; click?: () => void }[] = [];
  class N {
    entry: (typeof made)[number];
    constructor(opts: { title: string; body: string; silent: boolean }) {
      this.entry = { opts, shown: false, closed: false };
      made.push(this.entry);
    }
    show() {
      this.entry.shown = true;
    }
    close() {
      this.entry.closed = true;
    }
    on(event: string, fn: () => void) {
      if (event === "click") this.entry.click = fn;
    }
    static isSupported = () => true;
  }
  return { made, N };
}

describe("createNotifier", () => {
  const setup = (settings = { notifications: true, preview: true }) => {
    const { made, N } = fakeNotification();
    const onClick = vi.fn();
    const n = createNotifier({ Notification: N, settings: () => settings, onClick });
    return { made, n, onClick };
  };

  it("shows a silent:false notification and replaces the previous one of the same conversation", () => {
    const { made, n } = setup();
    n.show(ok);
    n.show({ ...ok, body: "tin mới hơn" });
    n.show({ ...ok, conversationKey: `dm:${ID.replace("1", "2")}` });
    expect(made.map((m) => [m.shown, m.closed, m.opts.silent])).toEqual([
      [true, true, false],
      [true, false, false],
      [true, false, false],
    ]);
  });

  it("a click asks to open the conversation; a call's click opens its DM", () => {
    const { made, n, onClick } = setup();
    n.show(ok);
    made[0].click!();
    n.show({ conversationKey: `call:${ID}`, title: "Ngọc", body: "Cuộc gọi đến", kind: "call" });
    made[1].click!();
    expect(onClick.mock.calls).toEqual([[`dm:${ID}`], [`dm:${ID}`]]);
  });

  it("close() closes a call's notification; an invalid key or payload throws; disabled shows nothing", () => {
    const { made, n } = setup();
    n.show({ conversationKey: `call:${ID}`, title: "Ngọc", body: "Cuộc gọi đến", kind: "call" });
    n.close(`call:${ID}`);
    expect(made[0].closed).toBe(true);
    expect(() => n.close("nope")).toThrow();
    expect(() => n.show({ ...ok, kind: "x" })).toThrow();
    const off = setup({ notifications: false, preview: true });
    off.n.show(ok);
    expect(off.made).toHaveLength(0);
  });
});
