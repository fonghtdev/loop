import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// After R3 + R4 no interactive element in the app keeps a native `title=` (it would show a second, unstyled tooltip on
// top of the shared Tooltip). What may remain: component props (`<Dialog title=...>`, capitalised tags) and the message
// timestamps / "(đã chỉnh sửa)" and the file caption, which are plain text (1100 Tooltips in a list would be too many).
const sources = [...readdirSync(join(__dirname, "components")).map((f) => `components/${f}`), ...readdirSync(join(__dirname, "screens")).map((f) => `screens/${f}`)].filter((f) => /\.tsx$/.test(f));
const INTERACTIVE = new Set(["button", "a", "input", "select", "textarea", "summary", "label", "li", "div", "h1", "p", "Button", "MenuItem", "RowMenu", "Control", "ActionButton", "RailButton", "RailItem"]);
/** Non-interactive text that may carry the full value, and where (file -> how many). */
const ALLOWED: Record<string, { tags: string[] }> = {
  "components/ChatView.tsx": { tags: ["time", "time", "span"] },
  "components/MessageAttachments.tsx": { tags: ["figcaption"] },
};

/** Every `title=` in the code (comments do not count) with the tag it sits on. */
export function titleAttributes(raw: string): { tag: string; at: number }[] {
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length)).replace(/^\s*\/\/.*$/gm, (c) => " ".repeat(c.length));
  return [...source.matchAll(/\btitle=/g)].map((m) => {
    const open = source.lastIndexOf("<", m.index);
    return { tag: /^<([A-Za-z][\w.]*)/.exec(source.slice(open))?.[1] ?? "?", at: m.index };
  });
}

describe("native title= tooltips", () => {
  it("the app has component files to scan", () => expect(sources.length).toBeGreaterThan(30));

  for (const file of sources)
    it(`${file}: none on an interactive element, and only the allow-listed text keeps one`, () => {
      const found = titleAttributes(readFileSync(join(__dirname, file), "utf8"));
      const bad = found.filter((a) => INTERACTIVE.has(a.tag));
      expect(bad, `${file} still has a native title= on ${bad.map((b) => b.tag).join(", ")}`).toEqual([]);
      const plain = found.filter((a) => !/^[A-Z]/.test(a.tag)).map((a) => a.tag);
      expect(plain, `${file}: lowercase tags with title=`).toEqual(ALLOWED[file]?.tags ?? []);
    });

  it("the scan itself sees a title on a button and a div, lets a <time> and a component prop through", () => {
    const found = titleAttributes('<button type="button" title="x">a</button><time title="y"></time><Dialog title="z"><div title="w" />');
    expect(found.map((f) => f.tag)).toEqual(["button", "time", "Dialog", "div"]);
    expect(found.filter((f) => INTERACTIVE.has(f.tag)).map((f) => f.tag)).toEqual(["button", "div"]);
  });
});
