import { Button } from "../components/Button";
import { LogoMark } from "../components/Logo";
import { Spinner } from "../components/Spinner";
import { t } from "../i18n/t";

/** Shown while the stored session is restored; `offline` when the server could not be reached. */
export function Splash({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-surface-1 p-8 text-center">
      <LogoMark animate className="size-16 text-moss-300" />
      <div aria-live="polite" className="flex min-h-11 flex-col items-center gap-4">
        {offline ? (
          <>
            <p className="max-w-[40ch] text-ink-muted">{t("splash.offline")}</p>
            <Button onClick={onRetry} autoFocus>
              {t("splash.retry")}
            </Button>
          </>
        ) : (
          <p className="flex items-center gap-2.5 text-ink-muted">
            <Spinner className="size-4 text-moss-300" />
            {t("splash.restoring")}
          </p>
        )}
      </div>
    </div>
  );
}
