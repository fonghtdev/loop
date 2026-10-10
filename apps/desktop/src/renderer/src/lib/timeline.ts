import { t } from "../i18n/t";
import type { Message } from "./chat";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type TimelineRow = {
  message: Message;
  /** Same author as the row above, within 5 minutes, same day: no avatar/name repeated. */
  grouped: boolean;
  /** A new day starts at this row: the separator label to show above it. */
  day?: string;
};

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const fullDate = new Intl.DateTimeFormat("vi-VN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const clock = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" });
const full = new Intl.DateTimeFormat("vi-VN", { dateStyle: "full", timeStyle: "short" });

/** "Hôm nay", "Hôm qua", or the full Vietnamese date (local time). */
export function dayLabel(date: Date, now = new Date()): string {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(date) === dayKey(now)) return t("chat.today");
  if (dayKey(date) === dayKey(yesterday)) return t("chat.yesterday");
  return fullDate.format(date);
}

export const timeOfDay = (iso: string) => clock.format(new Date(iso));
export const fullTimestamp = (iso: string) => full.format(new Date(iso));

/** Messages (ascending) into rows with author grouping and day separators. */
export function buildTimeline(messages: Message[], now = new Date()): TimelineRow[] {
  return messages.map((message, i) => {
    const prev = messages[i - 1];
    const at = new Date(message.createdAt);
    const newDay = !prev || dayKey(new Date(prev.createdAt)) !== dayKey(at);
    const grouped =
      !newDay && prev.author.id === message.author.id && at.getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
    return { message, grouped, day: newDay ? dayLabel(at, now) : undefined };
  });
}
