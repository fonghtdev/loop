import { categoryNameSchema, createChannelSchema, createGuildSchema, loginSchema, registerSchema, usernameSchema } from "@loop/shared";
import { t } from "../i18n/t";

export type Field = "email" | "username" | "password";
export type Values = Record<Field, string>;
type ZodIssue = NonNullable<ReturnType<typeof registerSchema.safeParse>["error"]>["issues"][number];

const usernameMessage = (issue: Pick<ZodIssue, "code">) =>
  issue.code === "too_small" ? t("validation.usernameShort") : issue.code === "too_big" ? t("validation.usernameLong") : t("validation.usernameChars");

function message(field: Field, issue: ZodIssue): string {
  if (field === "email") return t("validation.email");
  if (field === "username") return usernameMessage(issue);
  return issue.code === "too_big" ? t("validation.passwordLong") : t("validation.passwordShort");
}

/** A username typed to add a friend (the shared usernameSchema): Vietnamese error, or undefined when valid. */
export function usernameError(name: string): string | undefined {
  if (name === "") return t("validation.required");
  const issue = usernameSchema.safeParse(name).error?.issues[0];
  return issue ? usernameMessage(issue) : undefined;
}

/** Per-field Vietnamese errors from the same zod schemas the server uses (first problem per field). */
export function validate(mode: "login" | "register", values: Values): Partial<Record<Field, string>> {
  const fields: Field[] = mode === "login" ? ["email", "password"] : ["email", "username", "password"];
  const errors: Partial<Record<Field, string>> = {};
  for (const f of fields) if (values[f] === "") errors[f] = t("validation.required");
  const result = (mode === "login" ? loginSchema : registerSchema).safeParse(values);
  for (const issue of result.success ? [] : result.error.issues) {
    const f = issue.path[0] as Field;
    errors[f] ??= message(f, issue);
  }
  return errors;
}

/** Server name (createGuildSchema): Vietnamese error, or undefined when valid. */
export function guildNameError(name: string): string | undefined {
  if (name.trim() === "") return t("validation.required");
  return createGuildSchema.safeParse({ name }).success ? undefined : t("validation.guildNameLong");
}

/** Category name (categoryNameSchema): Vietnamese error, or undefined when valid. */
export function categoryNameError(name: string): string | undefined {
  if (name.trim() === "") return t("validation.required");
  return categoryNameSchema.safeParse({ name }).success ? undefined : t("validation.categoryNameLong");
}

/** Channel name (createChannelSchema: 1..100 of a-z 0-9 - _). */
export function channelNameError(name: string): string | undefined {
  if (name === "") return t("validation.required");
  const issue = createChannelSchema.safeParse({ name, type: "TEXT" }).error?.issues[0];
  if (!issue) return undefined;
  return issue.code === "too_big" ? t("validation.channelNameLong") : t("validation.channelNameChars");
}

/** What people type while naming a channel: lower case, spaces become dashes (Discord does the same). */
export const normalizeChannelName = (raw: string) => raw.toLowerCase().replace(/\s+/g, "-");

/** An invite code, or the code at the end of a pasted link; null when it cannot be one. */
export function parseInviteCode(raw: string): string | null {
  const code = raw.trim().split("/").filter(Boolean).pop() ?? "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : null;
}
