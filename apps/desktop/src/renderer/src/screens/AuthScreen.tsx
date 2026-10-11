import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { Collapse } from "../components/Collapse";
import { LogoMark, Wordmark } from "../components/Logo";
import { TextField } from "../components/TextField";
import { t } from "../i18n/t";
import { session } from "../lib/app";
import { ENTRANCE, playAuthEntrance } from "../lib/auth-motion";
import { errorMessage } from "../lib/errors";
import { validate, type Field, type Values } from "../lib/validation";

type Mode = "login" | "register";

export function AuthScreen() {
  const root = useRef<HTMLDivElement>(null);
  // before the first paint: hide the wrappers about to fade in (never the inputs), then play; under reduced motion nothing happens
  useLayoutEffect(() => playAuthEntrance(root.current!), []);
  return (
    <div ref={root} className="ambient relative grid h-full grid-cols-[minmax(0,5fr)_minmax(0,7fr)] overflow-hidden">
      <Aurora />
      <BrandPanel />
      <main className="relative overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[440px] flex-col justify-center px-6 py-6">
          <div data-enter-card className="glass rounded-glass p-7">
            <AuthForm />
          </div>
        </div>
      </main>
    </div>
  );
}

const BLOB = "aurora-blob bg-[radial-gradient(closest-side,var(--blob),transparent)]";
const star = (c: [number, number]) => <circle key={c.join()} cx={c[0]} cy={c[1]} r={c[0] % 3 ? 1 : 1.6} opacity={c[1] % 2 ? 0.5 : 0.8} fill="var(--color-ink)" />;

/** The backdrop: three slow aurora blobs (CSS drift, transform only, still under reduced motion) and three orbits drawn once. */
function Aurora() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <i className={`${BLOB} -top-[30%] -left-[8%] size-[760px] animate-drift-a [--blob:color-mix(in_srgb,var(--color-aurora-violet)_50%,transparent)]`} />
      <i className={`${BLOB} -right-[6%] -bottom-[34%] size-[680px] animate-drift-b [--blob:color-mix(in_srgb,var(--color-aurora-teal)_42%,transparent)]`} />
      <i className={`${BLOB} -top-[24%] right-[22%] size-[560px] animate-drift-c [--blob:color-mix(in_srgb,var(--color-aurora-blue)_34%,transparent)]`} />
      <svg viewBox="0 0 1100 700" preserveAspectRatio="xMidYMid slice" fill="none" className="absolute inset-0 size-full">
        <defs>
          <linearGradient id="auth-orbit" x1="0" y1="0" x2="1" y2="1">
            <stop style={{ stopColor: "var(--color-cosmic-300)" }} />
            <stop offset="1" style={{ stopColor: "var(--color-cosmic-teal)" }} />
          </linearGradient>
        </defs>
        {[
          [520, 190, 0.28],
          [380, 130, 0.28],
          [650, 260, 0.14],
        ].map(([rx, ry, o]) => (
          <ellipse key={rx} data-orbit pathLength={1} strokeDasharray={1} cx="550" cy="350" rx={rx} ry={ry} transform="rotate(-14 550 350)" stroke="url(#auth-orbit)" opacity={o} />
        ))}
        {([[120, 90], [260, 610], [880, 120], [1000, 520], [700, 640], [420, 60], [960, 300], [70, 400]] as [number, number][]).map(star)}
      </svg>
    </div>
  );
}

function BrandPanel() {
  return (
    <section className="relative flex flex-col justify-between overflow-hidden p-10">
      <div data-enter>
        <Wordmark />
      </div>
      {/* the mark again, oversized and quiet: the one decorative moment of the screen; it draws itself */}
      <LogoMark animate delay={ENTRANCE.logo.at} className="pointer-events-none absolute -top-36 -right-36 size-[380px] rotate-180 text-moss-900" />
      <div className="relative max-w-[30ch]">
        <p data-enter className="max-w-[18ch] font-display text-heading1 font-extrabold tracking-[-0.04em] text-balance text-ink min-[1100px]:text-display">
          {t("brand.headline")}
        </p>
        <p data-enter className="mt-4 text-ink">
          {t("brand.body")}
        </p>
      </div>
    </section>
  );
}

const empty: Values = { email: "", username: "", password: "" };

function AuthForm() {
  const [mode, setMode] = useState<Mode>("login");
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

  // One form for both modes: the shared fields are never re-mounted, so what was typed stays; only the old errors go.
  function switchMode() {
    setMode(mode === "login" ? "register" : "login");
    setErrors({});
    setTried(false);
    setServerError("");
    refs.email.current?.focus();
  }

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
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div data-enter>
        <header key={mode} className="animate-fade">
          <h1 className="font-display text-heading1 font-extrabold tracking-[-0.035em]">{t(login ? "auth.login.title" : "auth.register.title")}</h1>
          <p className="mt-1.5 text-ink-muted">{t(login ? "auth.login.subtitle" : "auth.register.subtitle")}</p>
        </header>
      </div>
      <div data-enter>
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
      </div>
      <Collapse open={!login} offset="-mb-4">
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
      </Collapse>
      <div data-enter>
        <TextField
          ref={refs.password}
          label={t("auth.password")}
          hint={t("auth.passwordHint")}
          hintOpen={!login}
          type="password"
          autoComplete={login ? "current-password" : "new-password"}
          value={values.password}
          onChange={change("password")}
          error={errors.password}
        />
      </div>
      <div aria-live="assertive" className="empty:hidden">
        {serverError && <Banner tone="danger">{serverError}</Banner>}
      </div>
      <div data-enter>
        <Button type="submit" loading={submitting} className="mt-1 w-full">
          {submitting ? t("auth.submitting") : t(login ? "auth.login.submit" : "auth.register.submit")}
        </Button>
      </div>
      <p data-enter className="flex items-center justify-center gap-1 text-sm text-ink-muted">
        {t(login ? "auth.login.switchPrompt" : "auth.register.switchPrompt")}
        <Button type="button" variant="link" onClick={switchMode} className="px-2">
          {t(login ? "auth.login.switchAction" : "auth.register.switchAction")}
        </Button>
      </p>
    </form>
  );
}
