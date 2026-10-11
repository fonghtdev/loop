import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
const walk = (dir: string): string[] => readdirSync(join(__dirname, dir)).flatMap((f) => (statSync(join(__dirname, dir, f)).isDirectory() ? walk(`${dir}/${f}`) : [`${dir}/${f}`]));

describe("redesign R5 source rules", () => {
  it("one window keydown listener for the shortcut, removed on cleanup, mounted only inside the signed-in Shell", () => {
    const users = walk(".").filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && /isToggleShortcut\(/.test(read(f)) && !f.endsWith("quick-switch-keys.ts"));
    expect(users).toEqual(["./components/QuickSwitcher.tsx"]);
    const src = read("components/QuickSwitcher.tsx");
    expect(src.match(/addEventListener\("keydown"/g)).toHaveLength(1);
    expect(src).toMatch(/window\.removeEventListener\("keydown", onKey\)/);
    expect(read("screens/Shell.tsx")).toMatch(/<QuickSwitcher \/>/);
    expect(walk(".").filter((f) => f.endsWith(".tsx") && /<QuickSwitcher \/>/.test(read(f)))).toEqual(["./screens/Shell.tsx"]);
  });
  it("choosing a channel (list or palette) goes through one function", () => {
    expect(read("components/ChannelColumn.tsx")).toMatch(/openChannel\(channel\)/);
    expect(read("components/QuickSwitcher.tsx")).toMatch(/openChannel\(target\.channel\)/);
  });
  it("matched letters are rendered as text nodes, never as HTML", () => {
    expect(read("components/QuickSwitcher.tsx")).not.toMatch(/dangerouslySetInnerHTML/);
  });
  it("the selection follows mousemove with real movement, not mouseenter", () => {
    const src = read("components/QuickSwitcher.tsx");
    expect(src).toMatch(/onMouseMove=\{\(e\) => \(e\.movementX \|\| e\.movementY\)/);
    expect(src).not.toMatch(/onMouseEnter/);
  });
});
