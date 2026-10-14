import type { Channel } from "@loop/shared";
import { describe, expect, it } from "vitest";
import { buildMessage, candidateChannels } from "./welcome.js";

const channel = (id: string, type: "TEXT" | "VOICE" = "TEXT"): Channel => ({ id, guildId: "g", name: id, type, position: 0, categoryId: null, createdAt: "" });

describe("buildMessage", () => {
  it("fills {user} and {guild}, every occurrence", () => {
    expect(buildMessage("Hi {user}, welcome to {guild}! Bye {user}", { user: "ann", guild: "HQ" })).toBe("Hi ann, welcome to HQ! Bye ann");
  });

  it("does not re-expand placeholders that a name brings along", () => {
    expect(buildMessage("{user} / {guild}", { user: "{guild}", guild: "HQ" })).toBe("{guild} / HQ");
  });
});

describe("candidateChannels", () => {
  const all = [channel("v", "VOICE"), channel("a"), channel("b")];

  it("without a configured channel: every text channel in the given order, no voice", () => {
    expect(candidateChannels(all).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("with a configured channel: only that one, and only if it is a text channel the bot can see", () => {
    expect(candidateChannels(all, "b").map((c) => c.id)).toEqual(["b"]);
    expect(candidateChannels(all, "v")).toEqual([]);
    expect(candidateChannels(all, "gone")).toEqual([]);
  });
});
