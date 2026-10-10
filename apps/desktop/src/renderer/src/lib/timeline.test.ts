import { describe, expect, it } from "vitest";
import type { Message } from "./chat";
import { buildTimeline, dayLabel } from "./timeline";

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();
const m = (id: string, author: string, createdAt: string): Message => ({
  id,
  channelId: "c",
  author: { id: author, username: author },
  content: id,
  createdAt,
  editedAt: null,
  seq: id,
});
const now = new Date(2026, 9, 10, 18, 0);

describe("buildTimeline", () => {
  it("groups consecutive messages of one author within 5 minutes", () => {
    const rows = buildTimeline(
      [
        m("1", "an", at(2026, 10, 10, 9, 0)),
        m("2", "an", at(2026, 10, 10, 9, 4)),
        m("3", "an", at(2026, 10, 10, 9, 10)), // 6 min after the previous one
        m("4", "binh", at(2026, 10, 10, 9, 11)),
        m("5", "an", at(2026, 10, 10, 9, 12)), // someone spoke in between
      ],
      now,
    );
    expect(rows.map((r) => r.grouped)).toEqual([false, true, false, false, false]);
  });

  it("puts a Vietnamese day separator where the day changes, and never groups across it", () => {
    const rows = buildTimeline(
      [m("1", "an", at(2026, 10, 3, 23, 58)), m("2", "an", at(2026, 10, 9, 23, 59)), m("3", "an", at(2026, 10, 10, 0, 1))],
      now,
    );
    expect(rows.map((r) => r.day)).toEqual(["Thứ Bảy, 3 tháng 10, 2026", "Hôm qua", "Hôm nay"]);
    expect(rows[2].grouped).toBe(false);
  });

  it("dayLabel: today / yesterday / full date", () => {
    expect(dayLabel(new Date(2026, 9, 10, 1), now)).toBe("Hôm nay");
    expect(dayLabel(new Date(2026, 9, 9, 23), now)).toBe("Hôm qua");
    expect(dayLabel(new Date(2025, 0, 1), now)).toMatch(/2025/);
  });
});
