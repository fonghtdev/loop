import { useRef, useState, type FormEvent } from "react";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { LogoMark, Wordmark } from "../components/Logo";
import { TextField } from "../components/TextField";
import { t } from "../i18n/t";
import { session } from "../lib/app";
import { errorMessage } from "../lib/errors";
import { validate, type Field, type Values } from "../lib/validation";

type Mode = "login" | "register";

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>("login");
  return (
    <div className="ambient grid h-full grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <BrandPanel />
      <main className="overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[440px] flex-col justify-center px-6 py-6">
          <div className="glass rounded-panel p-7">
            <AuthForm key={mode} mode={mode} onSwitch={() => setMode(mode === "login" ? "register" : "login")} />
          </div>
        </div>
      </main>
    </div>
  );
}

function BrandPanel() {
  return (
    <section className="relative flex flex-col justify-between overflow-hidden p-10">
      <Wordmark />
      {/* the mark again, oversized and quiet: the one decorative moment of the screen */}
      <LogoMark animate className="pointer-events-none absolute -top-36 -right-36 size-[380px] rotate-180 text-moss-900" />
      <div className="relative max-w-[30ch]">
        <p className="font-display text-[34px] leading-[1.15] font-bold tracking-tight text-ink">{t("brand.headline")}</p>
        <p className="mt-4 text-ink-muted">{t("brand.body")}</p>
      </div>
    </section>
  );
}

const empty: Values = { email: "", username: "", password: "" };

function AuthForm({ mode, onSwitch }: { mode: Mode; onSwitch: () => void }) {
  const [values, setValues] = useState(empty);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [tried, setTried] = useState(false); // errors show after the first submit, then update as you type
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const refs = { email: useRef<HTMLInputElement>(null), username: useRef<HTMLInputElement>(null), password: useRef<HTMLInputElement>(null) };

  const change = (field: Field) => (e: { target: { value: string } }) => {
    const next = { ...values, [field]: e.target.value };
    setValues(next);
    if (tried) setErrors(validate(mode, next));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setTried(true);
    const found = validate(mode, values);
    setErrors(found);
    const first = (["email", "username", "password"] as const).find((f) => found[f]);
    if (first) return refs[first].current?.focus();
    setServerError("");
    setSubmitting(true);
    try {
      if (mode === "login") await session.login({ email: values.email, password: values.password });
      else await session.register(values);
    } catch (err) {
      setServerError(errorMessage(err));
      setSubmitting(false);
    }
  }

  const login = mode === "login";
  return (
    <form onSubmit={submit} noValidate className="flex animate-rise flex-col gap-4">
      <header>
        <h1 className="font-display text-[28px] leading-tight font-bold tracking-tight">{t(login ? "auth.login.title" : "auth.register.title")}</h1>
        <p className="mt-1.5 text-ink-muted">{t(login ? "auth.login.subtitle" : "auth.register.subtitle")}</p>
      </header>
      <TextField
        ref={refs.email}
        label={t("auth.email")}
        type="email"
        autoComplete="email"
        autoFocus
        value={values.email}
        onChange={change("email")}
        error={errors.email}
      />
      {!login && (
        <TextField
          ref={refs.username}
          label={t("auth.username")}
          hint={t("auth.usernameHint")}
          autoComplete="username"
          spellCheck={false}
          autoCapitalize="none"
          value={values.username}
          onChange={change("username")}
          error={errors.username}
        />
      )}
      <TextField
        ref={refs.password}
        label={t("auth.password")}
        hint={login ? undefined : t("auth.passwordHint")}
        type="password"
        autoComplete={login ? "current-password" : "new-password"}
        value={values.password}
        onChange={change("password")}
        error={errors.password}
      />
      <div aria-live="assertive" className="empty:hidden">
        {serverError && <Banner tone="danger">{serverError}</Banner>}
      </div>
      <Button type="submit" loading={submitting} className="mt-1 w-full">
        {submitting ? t("auth.submitting") : t(login ? "auth.login.submit" : "auth.register.submit")}
      </Button>
      <p className="flex items-center justify-center gap-1 text-sm text-ink-muted">
        {t(login ? "auth.login.switchPrompt" : "auth.register.switchPrompt")}
        <Button type="button" variant="link" onClick={onSwitch} className="px-2">
          {t(login ? "auth.login.switchAction" : "auth.register.switchAction")}
        </Button>
      </p>
    </form>
  );
}
