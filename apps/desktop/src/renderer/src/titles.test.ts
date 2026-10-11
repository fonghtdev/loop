import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// R3 migrated these to the shared Tooltip: no interactive element in them may keep a native `title=` (which would
// show a second, unstyled tooltip on top of ours). Components such as <Dialog title=...> take `title` as a prop, not
// as the HTML attribute, and non-interactive text (<time title>, truncated names) may keep it: they are allowed below.
const migrated = [
  "components/ServerRail.tsx",
  "components/ChannelColumn.tsx",
  "components/ChatView.tsx",
  "components/Composer.tsx",
  "components/MessageAttachments.tsx",
  "components/AttachmentTray.tsx",
  "components/MemberList.tsx",
  "components/VoiceBar.tsx",
  "components/RowMenu.tsx",
  "components/DmView.tsx",
  "components/DmColumn.tsx",
  "components/UserSettings.tsx",
  "screens/Shell.tsx",
];
const INTERACTIVE = new Set(["button", "a", "input", "select", "textarea", "summary", "label", "Button", "MenuItem", "RowMenu", "Control", "ActionButton", "RailButton", "RailItem"]);
const ALLOWED = new Set(["time", "span", "p", "h1", "figcaption"]); // non-interactive text that may carry the full value

/** Every `title=` in the source with the tag it sits on. */
export function titleAttributes(source: string): { tag: string; at: number }[] {
  return [...source.matchAll(/\btitle=/g)].map((m) => {
    const open = source.lastIndexOf("<", m.index);
    return { tag: /^<([A-Za-z][\w.]*)/.exec(source.slice(open))?.[1] ?? "?", at: m.index };
  });
}

describe("native title= tooltips", () => {
  for (const file of migrated)
    it(`${file}: none on an interactive element`, () => {
      const bad = titleAttributes(readFileSync(join(__dirname, file), "utf8")).filter((a) => INTERACTIVE.has(a.tag));
      expect(bad, `${file} still has a native title= on ${bad.map((b) => b.tag).join(", ")}`).toEqual([]);
    });

  it("the scan itself sees a title on a button and lets a <time> through", () => {
    const found = titleAttributes('<button type="button" title="x">a</button><time title="y"></time>');
    expect(found.map((f) => f.tag)).toEqual(["button", "time"]);
    expect(found.filter((f) => INTERACTIVE.has(f.tag))).toHaveLength(1);
  });

  it("whatever else keeps a title= in these files is on the allow-list of non-interactive tags or is a component prop", () => {
    for (const file of migrated)
      for (const a of titleAttributes(readFileSync(join(__dirname, file), "utf8")))
        expect(INTERACTIVE.has(a.tag) || ALLOWED.has(a.tag) || /^[A-Z]/.test(a.tag), `${file}: ${a.tag}`).toBe(true);
  });
});
