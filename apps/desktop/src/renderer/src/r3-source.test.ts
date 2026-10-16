import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
const chat = read("components/ChatView.tsx");

describe("redesign R3 chat source rules", () => {
  it("the toolbar buttons are 40x40 (size-10); the real measure is the e2e bounding box", () => {
    const action = chat.slice(chat.indexOf("function ActionButton"), chat.indexOf("function EditBox"));
    expect(action).toMatch(/\bsize-10\b/);
    expect(action).not.toMatch(/\bsize-(?:[1-9]|[1-9][0-9]?)\b(?<!size-10)/);
  });
  it("the day separator is CSS sticky (no scroll listener in the chat)", () => {
    expect(chat).toMatch(/role="separator"[^>]*className="sticky top-0/);
    expect(chat).not.toMatch(/addEventListener\("scroll"|IntersectionObserver/);
  });
  it("only the arrival helper animates, and only through lib/motion", () => {
    expect(chat).not.toMatch(/from "animejs"/);
    expect(chat).toMatch(/shouldAnimateArrival\(/);
    expect(chat.match(/\bmove\(/g)).toHaveLength(1);
  });
  it("message rows read their sizes from the density variables, not fixed pixels", () => {
    expect(chat).toMatch(/grid-cols-\[var\(--m-av\)_minmax\(0,1fr\)\]/);
    expect(read("components/MessageText.tsx")).toMatch(/text-\(length:--m-fs\) leading-\(--m-lh\)/); // the text moved out of ChatView with the formatting
  });
  it("copy: the label morphs to the copied text and a polite live region announces it", () => {
    expect(chat).toMatch(/copied \? t\("common\.copied"\) : t\("chat\.copy"\)/);
    expect(chat).toMatch(/aria-live="polite" className="sr-only"/);
  });
});
