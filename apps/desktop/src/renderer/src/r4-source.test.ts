import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
const walk = (dir: string): string[] => readdirSync(join(__dirname, dir)).flatMap((f) => (statSync(join(__dirname, dir, f)).isDirectory() ? walk(`${dir}/${f}`) : [`${dir}/${f}`]));

describe("redesign R4 source rules", () => {
  it("anime.js is imported by lib/motion.ts only (every animation goes through its budget)", () => {
    const users = walk(".").filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && /from "animejs"/.test(read(f)));
    expect(users).toEqual(["./lib/motion.ts"]);
  });
  it("the member column is hidden by one rule in Shell, only for an open voice room", () => {
    const shell = read("screens/Shell.tsx");
    expect(shell.match(/voiceRoomOpen/g)!.length).toBeGreaterThanOrEqual(3);
    expect(shell).toMatch(/const voiceRoomOpen = isVoiceChannel && !!guildId && !settings;/);
  });
  it("the toast live region is always in the page; only the pill comes and goes", () => {
    const toast = read("components/Toast.tsx");
    expect(toast).toMatch(/<div role="status" aria-live="polite"[^>]*>\s*\{current && \(/);
  });
  it("the viewer closes through one function, keeps the native autofocus on Close and has no leftover animate-rise", () => {
    const viewer = read("components/ImageViewer.tsx");
    expect(viewer).not.toMatch(/animate-rise/);
    expect(viewer).toMatch(/onCancel=\{\(e\) => \(e\.preventDefault\(\), requestClose\(\)\)\}/);
    expect(viewer).toMatch(/setAttribute\("autofocus", ""\)/);
  });
  it("the speaking ring is driven by the --lv variable, not by per-frame JS", () => {
    const tile = read("components/ParticipantTile.tsx");
    expect(tile).toMatch(/"--lv":/);
    expect(tile).not.toMatch(/requestAnimationFrame|setInterval/);
  });
  it("the tri-state keeps its native radios (the thumb is decoration)", () => {
    const seg = read("components/Segmented.tsx");
    expect(seg).toMatch(/type="radio"/);
    expect(seg).toMatch(/aria-hidden="true"\s+data-seg-thumb/);
  });
});
