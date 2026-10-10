import { loginSchema, registerSchema } from "@loop/shared";
import { t } from "../i18n/t";

export type Field = "email" | "username" | "password";
export type Values = Record<Field, string>;
type ZodIssue = NonNullable<ReturnType<typeof registerSchema.safeParse>["error"]>["issues"][number];

function message(field: Field, issue: ZodIssue): string {
  if (field === "email") return t("validation.email");
  const tooSmall = issue.code === "too_small";
  const tooBig = issue.code === "too_big";
  if (field === "username") {
    return tooSmall ? t("validation.usernameShort") : tooBig ? t("validation.usernameLong") : t("validation.usernameChars");
  }
  return tooBig ? t("validation.passwordLong") : t("validation.passwordShort");
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
