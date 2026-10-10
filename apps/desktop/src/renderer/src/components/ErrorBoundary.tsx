import { Component, type ReactNode } from "react";
import { t } from "../i18n/t";
import { Button } from "./Button";
import { LogoMark } from "./Logo";

/** Last resort for render errors: a calm screen with a reload instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 bg-surface-2 p-8 text-center">
        <LogoMark className="size-12 text-moss-300" />
        <h1 className="font-display text-2xl font-bold">{t("crash.title")}</h1>
        <p className="max-w-[44ch] text-ink-muted">{t("crash.body")}</p>
        <Button onClick={() => location.reload()}>{t("crash.reload")}</Button>
      </div>
    );
  }
}
