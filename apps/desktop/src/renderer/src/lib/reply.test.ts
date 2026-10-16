import { describe, expect, it } from "vitest";
import type { Message } from "./chat";
import { cancelsReply, liveReplyTarget } from "./reply";

const m = (id: string) => ({ id }) as Message;

describe("reply state of the composer", () => {
  it("the target stays while its message is listed and clears when it is gone", () => {
    const target = m("a");
    expect(liveReplyTarget(target, [m("a"), m("b")])).toBe(target);
    expect(liveReplyTarget(target, [m("b")])).toBeNull();
    expect(liveReplyTarget(null, [m("b")])).toBeNull();
  });

  it("Esc cancels only an active reply, and never during IME composition", () => {
    expect(cancelsReply({ key: "Escape" }, true)).toBe(true);
    expect(cancelsReply({ key: "Escape" }, false)).toBe(false);
    expect(cancelsReply({ key: "Escape", isComposing: true }, true)).toBe(false);
    expect(cancelsReply({ key: "a" }, true)).toBe(false);
  });
});
