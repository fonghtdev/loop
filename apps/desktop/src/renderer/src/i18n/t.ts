import { vi, type MessageKey } from "./vi";

// ponytail: one language, no i18n library; when English lands, pick the dictionary here (and type it as the vi shape)
export function t(key: MessageKey, vars?: Record<string, string>): string {
  return vars ? vi[key].replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m) : vi[key];
}
