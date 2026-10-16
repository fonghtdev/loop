import { AUDIT_ACTIONS, AUDIT_GROUPS, type AuditEntryDto } from "@loop/shared";
import { describe, expect, it } from "vitest";
import { actorChoices, AUDIT_FILTERS, auditQuery, auditSentence, relativeTime, SENTENCES } from "./audit";

const user = (id: string, displayName: string | null = null) => ({ id, username: id, displayName, avatarHash: null });
const entry = (action: string, over: Partial<AuditEntryDto> = {}): AuditEntryDto => ({
  id: "e1", action, actor: user("an", "An"), targetUser: user("binh", "Bình"), targetId: "c1", meta: {}, createdAt: "2026-10-16T10:00:00.000Z", ...over,
});
const lookup = { nameOf: (u: { displayName: string | null; username: string }) => u.displayName || u.username, channelName: (id: string) => (id === "c1" ? "chung" : undefined) };
const say = (e: AuditEntryDto) => auditSentence(e, lookup);

describe("audit sentences", () => {
  it("every action of the server has a sentence, and every filter group exists", () => {
    expect(Object.keys(SENTENCES).sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect(AUDIT_FILTERS.map((f) => f.group).filter(Boolean).sort()).toEqual([...AUDIT_GROUPS].sort());
  });

  it.each(AUDIT_ACTIONS.map((a) => [a]))("%s reads as a complete sentence naming the actor", (action) => {
    const { text } = say(entry(action, { meta: { name: "Mod", channel: "chung", role: "Mod", rule: "Từ cấm", removed: false } }));
    expect(text).not.toMatch(/[{}]/);
    expect(text).toMatch(action === "automod.block" ? /^AutoMod/ : /^An /);
  });

  it("fills in names, the channel by id, variants and details", () => {
    expect(say(entry("member.kick")).text).toBe("An đã đuổi Bình khỏi máy chủ");
    expect(say(entry("message.delete")).text).toBe("An đã xoá một tin nhắn của Bình trong kênh chung");
    expect(say(entry("message.delete", { targetId: "gone" })).text).toBe("An đã xoá một tin nhắn của Bình trong kênh một kênh");
    expect(say(entry("channel.overwrite_set", { meta: { channel: "chung", role: null, allow: 1, deny: 0 } })).text).toBe("An đã đặt quyền riêng cho Bình trong kênh chung");
    expect(say(entry("channel.overwrite_set", { meta: { channel: "chung", role: "Mod", allow: 1, deny: 0 } })).text).toBe("An đã đặt quyền riêng cho vai trò Mod trong kênh chung");
    expect(say(entry("guild.icon", { meta: { removed: true } })).text).toBe("An đã xoá biểu tượng máy chủ");
    expect(say(entry("member.ban", { meta: { reason: "spam", deleteMessageHours: 1, deletedMessages: 3 } })).detail).toBe("Lý do: spam · Đã xoá 3 tin nhắn");
    expect(say(entry("member.ban", { meta: { reason: null, deleteMessageHours: 0, deletedMessages: 0 } })).detail).toBe("Không ghi lý do");
    expect(say(entry("role.update", { meta: { name: "Mod", changed: ["name", "permissions"] } })).detail).toBe("Đã đổi: tên, quyền");
    expect(say(entry("automod.block", { actor: null, targetId: "rule", meta: { rule: "Từ cấm", channelId: "c1" } })).text).toBe("AutoMod đã chặn một tin nhắn của Bình trong kênh chung (quy tắc Từ cấm)");
    expect(say(entry("member.kick", { actor: null, targetUser: null })).text).toBe("Tài khoản đã xoá đã đuổi Tài khoản đã xoá khỏi máy chủ");
  });

  it("an action from a newer server is shown generically, never as HTML or a crash", () => {
    expect(say(entry("guild.<b>future</b>", { meta: null as never }))).toEqual({ text: "An đã thực hiện một thao tác (guild.<b>future</b>)", detail: null });
  });
});

describe("audit filters and time", () => {
  it("builds the page query: empty filters left out, the cursor when paging", () => {
    expect(auditQuery({ group: "", actorId: "" })).toBe("limit=25");
    expect(auditQuery({ group: "voice", actorId: "u1", before: "e9" })).toBe("limit=25&action=voice&actorId=u1&before=e9");
  });
  it("actor choices: members plus actors seen in the log, by name", () => {
    const choices = actorChoices([entry("member.kick", { actor: user("zed", "Ánh") })], [user("an", "An"), user("binh", "Bình")], lookup.nameOf);
    expect(choices.map((c) => c.id)).toEqual(["an", "zed", "binh"]);
  });
  it("relative time, with 'vừa xong' under a minute", () => {
    const now = Date.parse("2026-10-16T10:00:00.000Z");
    expect(relativeTime("2026-10-16T09:59:30.000Z", now)).toBe("vừa xong");
    expect(relativeTime("2026-10-16T09:55:00.000Z", now)).toMatch(/5 phút trước/);
    expect(relativeTime("2026-10-15T10:00:00.000Z", now)).toMatch(/hôm qua/i);
  });
});
