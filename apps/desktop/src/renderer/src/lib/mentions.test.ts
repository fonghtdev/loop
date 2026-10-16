import { describe, expect, it } from "vitest";
import { Permission } from "@loop/shared";
import { activeMention, mentionable, insertMention, mentionsMe, rankCandidates, readable, toDraft, toWire, tokenFor, type Candidate, type MentionToken } from "./mentions";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const person = (userId: string, username: string, displayName?: string): Candidate => ({ userId, username, displayName });

describe("activeMention", () => {
  it.each([
    ["@", 1, { start: 0, query: "" }],
    ["hi @an", 6, { start: 3, query: "an" }],
    ["hi\n@an", 6, { start: 3, query: "an" }],
    ["@an and more", 3, { start: 0, query: "an" }], // the caret decides, not the end of the text
  ])("%j at %i", (text, caret, expected) => expect(activeMention(text, caret)).toEqual(expected));

  it.each([
    ["mail me@example.com", 19],
    ["no at sign", 5],
    ["@an and", 7], // the caret is past a space: the token is finished
    ["a@b", 3],
  ])("%j at %i opens nothing", (text, caret) => expect(activeMention(text, caret)).toBeNull());
});

describe("rankCandidates", () => {
  const people = [person("1", "zed", "Annabel"), person("2", "ann", "Zoe"), person("3", "lee", "Joanna"), person("4", "x", "Đạt"), person("5", "bo", "Bob Ann")];
  const names = (q: string) => rankCandidates(people, q).map((p) => p.userId);

  it("name prefix, then username prefix, then word start, then anywhere", () => {
    expect(names("ann")).toEqual(["1", "2", "5", "3"]);
  });
  it("ignores case and accents; Vietnamese d matches đ", () => {
    expect(names("ANN")).toEqual(names("ann"));
    expect(names("dat")).toEqual(["4"]);
  });
  it("an empty query lists everyone alphabetically; no match lists nobody", () => {
    expect(names("")).toEqual(["1", "5", "4", "3", "2"]);
    expect(names("qqq")).toEqual([]);
  });
  it("is capped", () => {
    expect(rankCandidates(Array.from({ length: 30 }, (_, i) => person(String(i), `u${i}`)), "u")).toHaveLength(8);
  });
});

describe("insertMention and tokenFor", () => {
  it("replaces the typed query by `@label ` and moves the caret past it", () => {
    expect(insertMention("hi @an there", 3, 6, "Ann")).toEqual({ text: "hi @Ann  there", caret: 8 });
  });
  it("falls back to the username when another member's token already has the label", () => {
    const tokens: MentionToken[] = [{ label: "Sam", id: A }];
    expect(tokenFor(person(B, "sam2", "Sam"), tokens)).toEqual({ label: "sam2", id: B });
    expect(tokenFor(person(A, "sam", "Sam"), tokens)).toEqual({ label: "Sam", id: A }); // the same person again
  });
});

describe("toWire", () => {
  const tokens: MentionToken[] = [{ label: "Ann", id: A }, { label: "Ann Lee", id: B }];

  it("converts tokens that are still intact", () => {
    expect(toWire("hi @Ann, and @Ann Lee!", tokens)).toBe(`hi <@${A}>, and <@${B}>!`);
  });
  it("leaves an edited or half-deleted label as text", () => {
    expect(toWire("hi @Ann Le", tokens)).toBe(`hi <@${A}> Le`); // the shorter, intact token still counts
    expect(toWire("hi @Anne", tokens)).toBe("hi @Anne");
    expect(toWire("hi @nn", tokens)).toBe("hi @nn");
    expect(toWire("hi Ann", tokens)).toBe("hi Ann");
  });
  it("does not convert inside a word or an address", () => {
    expect(toWire("mail me@Ann.com or x@Ann", tokens)).toBe("mail me@Ann.com or x@Ann");
  });
  it("a deleted token (label gone from the text) converts nothing", () => {
    expect(toWire("plain", tokens)).toBe("plain");
  });
  it("labels with regex characters and non-Latin letters are literal", () => {
    expect(toWire("@a.b (x) and @Đạt", [{ label: "a.b (x)", id: A }, { label: "Đạt", id: B }])).toBe(`<@${A}> and <@${B}>`);
    expect(toWire("@axb", [{ label: "a.b", id: A }])).toBe("@axb");
  });
  it("converts a repeated label everywhere", () => {
    expect(toWire("@Ann @Ann", tokens)).toBe(`<@${A}> <@${A}>`);
  });
  it("with no tokens the text is untouched", () => {
    expect(toWire("@Ann", [])).toBe("@Ann");
  });
});

describe("readable and toDraft", () => {
  const nameOf = (id: string) => (id === A ? "Ann" : undefined);
  it("shows known ids as @name and leaves unknown ones alone", () => {
    expect(readable(`hi <@${A}> and <@${B}>`, nameOf)).toBe(`hi @Ann and <@${B}>`);
  });
  it("a sent message becomes an editable draft and back again", () => {
    const content = `hi <@${A}>, ok? <@${B}>`;
    const { text, tokens } = toDraft(content, nameOf);
    expect(text).toBe(`hi @Ann, ok? <@${B}>`);
    expect(toWire(text, tokens)).toBe(content);
  });
  it("a token glued to a letter stays raw so editing cannot lose it", () => {
    const content = `x<@${A}> <@${A}>y`;
    const { text, tokens } = toDraft(content, nameOf);
    expect(text).toBe(content);
    expect(toWire(text, tokens)).toBe(content);
  });
});

describe("mentionsMe", () => {
  it("names me, or a permitted @everyone; never when absent", () => {
    expect(mentionsMe({ mentions: [A] }, A)).toBe(true);
    expect(mentionsMe({ mentions: [B] }, A)).toBe(false);
    expect(mentionsMe({ mentionEveryone: true }, A)).toBe(true);
    expect(mentionsMe({}, A)).toBe(false); // a server older than mentions
    expect(mentionsMe({ mentionEveryone: true }, undefined)).toBe(false);
  });
});

describe("mentionable", () => {
  const guild = { id: "g", name: "g", ownerId: "owner", createdAt: "" };
  const member = (userId: string, roleIds: string[] = []) => ({ userId, username: userId, isBot: false, joinedAt: "", createdAt: "", roleIds });
  const roles = [
    { id: "g", guildId: "g", name: "@everyone", permissions: Permission.VIEW_CHANNEL, position: 0 },
    { id: "staff", guildId: "g", name: "staff", permissions: 0, position: 1 },
  ];
  const data = { userId: "me", guild, roles, members: [member("owner"), member("me"), member("ann"), member("bob", ["staff"])] };

  it("everyone who can see the channel except me", () => {
    expect(mentionable(data, { overwrites: [] }, "me").map((c) => c.userId)).toEqual(["owner", "ann", "bob"]);
  });
  it("a private channel offers only those who can see it", () => {
    const hidden = { overwrites: [{ roleId: "g", allow: 0, deny: Permission.VIEW_CHANNEL }, { roleId: "staff", allow: Permission.VIEW_CHANNEL, deny: 0 }] };
    expect(mentionable(data, hidden, "me").map((c) => c.userId)).toEqual(["owner", "bob"]); // the owner sees everything
  });
  it("offers nobody without a channel", () => {
    expect(mentionable(data, undefined, "me")).toEqual([]);
  });
});
