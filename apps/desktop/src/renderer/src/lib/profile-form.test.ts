import { describe, expect, it } from "vitest";
import { draftErrors, draftOf, profilePatch } from "./profile-form";

const stored = { displayName: "Anh", bio: "Xin chào", statusText: null };

describe("profile form", () => {
  it("starts from the stored profile; null is an empty box", () => expect(draftOf(stored)).toEqual({ displayName: "Anh", bio: "Xin chào", statusText: "" }));

  it("validates with the shared schemas, counting characters like the server (an emoji is one)", () => {
    expect(draftErrors({ displayName: "😀".repeat(32), bio: "", statusText: "" })).toEqual({});
    expect(draftErrors({ displayName: "😀".repeat(33), bio: "", statusText: "" }).displayName).toMatch(/32/);
    expect(draftErrors({ displayName: "a", bio: "b".repeat(191), statusText: "" }).bio).toMatch(/190/);
    expect(draftErrors({ displayName: "a", bio: "", statusText: "x".repeat(129) }).statusText).toMatch(/128/);
  });
  it("refuses control and bidi characters; a bio may keep line breaks but a status or name may not", () => {
    expect(draftErrors({ displayName: "a\nb", bio: "", statusText: "" }).displayName).toBeDefined();
    expect(draftErrors({ displayName: "a", bio: "", statusText: "x‮y" }).statusText).toBeDefined();
    expect(draftErrors({ displayName: "a", bio: "dòng 1\ndòng 2", statusText: "" })).toEqual({});
  });
  it("an empty display name is allowed (it falls back to the username)", () => expect(draftErrors({ displayName: "  ", bio: "", statusText: "" })).toEqual({}));

  it("sends only the fields that differ", () => {
    expect(profilePatch(stored, draftOf(stored))).toBeNull();
    expect(profilePatch(stored, { ...draftOf(stored), statusText: "bận" })).toEqual({ statusText: "bận" });
    expect(profilePatch(stored, { displayName: "Anh Nhỏ", bio: "Xin chào", statusText: "" })).toEqual({ displayName: "Anh Nhỏ" });
  });
  it("trailing spaces are not a change; clearing a field sends null", () => {
    expect(profilePatch(stored, { ...draftOf(stored), displayName: "Anh  " })).toBeNull();
    expect(profilePatch(stored, { ...draftOf(stored), bio: "" })).toEqual({ bio: null });
    expect(profilePatch(stored, { ...draftOf(stored), displayName: "" })).toEqual({ displayName: null });
  });
  it("nothing is sent while any field is invalid", () => expect(profilePatch(stored, { ...draftOf(stored), displayName: "x".repeat(40), statusText: "ok" })).toBeNull());
});
