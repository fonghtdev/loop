import { Eye, EyeSlash } from "@phosphor-icons/react";
import { useId, useState, type InputHTMLAttributes, type Ref } from "react";
import { t } from "../i18n/t";
import { Collapse } from "./Collapse";
import { Tooltip } from "./Tooltip";

type Props = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; hintOpen?: boolean; error?: string; ref?: Ref<HTMLInputElement> };

/** Label above, hint and error below (both wired to the input for screen readers); passwords get a show/hide toggle. */
export function TextField({ label, hint, hintOpen = true, error, type = "text", ref, ...rest }: Props) {
  const id = useId();
  const [reveal, setReveal] = useState(false);
  const isPassword = type === "password";
  const hintShown = !!hint && hintOpen && !error;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <div className={`relative ${error ? "animate-shake" : ""}`}>
        <input
          {...rest}
          ref={ref}
          id={id}
          type={isPassword && reveal ? "text" : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${hintShown ? `${id}-hint ` : ""}${id}-error`}
          className={`h-11 w-full rounded-control border bg-surface-3 px-3.5 text-[15px] text-ink transition-colors duration-(--duration-fast) placeholder:text-ink-faint hover:bg-surface-4 ${isPassword ? "pr-12" : ""} ${error ? "border-danger" : "border-line-strong focus-visible:border-cosmic-300"}`}
        />
        {isPassword && (
          <Tooltip label={reveal ? t("auth.hidePassword") : t("auth.showPassword")}>
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? t("auth.hidePassword") : t("auth.showPassword")}
              aria-pressed={reveal}
              className="absolute top-0.5 right-0.5 grid size-10 place-items-center rounded-[10px] text-ink-muted transition-colors hover:bg-surface-4 hover:text-ink"
            >
              {reveal ? <EyeSlash aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </button>
          </Tooltip>
        )}
      </div>
      {hint && (
        <Collapse open={hintShown} offset="-mt-1.5">
          <p id={`${id}-hint`} className="text-[13px] text-ink-faint">
            {hint}
          </p>
        </Collapse>
      )}
      <p id={`${id}-error`} aria-live="polite" className="text-[13px] font-medium text-danger empty:hidden">
        {error && (
          <span key={error} className="inline-block animate-err">
            {error}
          </span>
        )}
      </p>
    </div>
  );
}
