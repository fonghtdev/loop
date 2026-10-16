import { Gif } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { GifResult } from "@loop/shared";
import { t } from "../i18n/t";
import { session } from "../lib/app";
import { createGifPicker, gifApi, useGifsAvailable, useShowGifs } from "../lib/gifs";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";

const COLUMNS = 2;

/** Arrow keys over a grid of `count` tiles in `COLUMNS` columns; null = not a movement key. */
function moveTile(i: number, key: string, count: number): number | null {
  const next = { ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - COLUMNS, ArrowDown: i + COLUMNS, Home: 0, End: count - 1 }[key];
  return next === undefined ? null : Math.max(0, Math.min(count - 1, next));
}

/**
 * The composer's GIF button and its popover (native `popover`: light dismiss and Esc for free, opens above the
 * button). Search box on top, a 2-column grid of previews (one tab stop; arrows move, Enter sends), "Xem thêm"
 * and the GIPHY attribution below. The content mounts only while open, so closed it costs nothing and loads
 * nothing from GIPHY. Hidden when the server has no provider or the user turned GIFs off.
 */
export function GifPicker({ disabled, onPick, onClosed }: { disabled: boolean; onPick: (gif: GifResult) => void; onClosed: () => void }) {
  const id = useId().replace(/:/g, "");
  const available = useGifsAvailable(session.client.request);
  const show = useShowGifs();
  const [open, setOpen] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!available || !show) return null;
  return (
    <>
      <Tooltip label={t("gif.button")}>
        <span className="inline-flex">
          <button
            ref={trigger}
            type="button"
            popoverTarget={`gif-${id}`}
            disabled={disabled}
            aria-label={t("gif.button")}
            style={{ anchorName: `--gif-${id}` }}
            className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-4 hover:text-ink active:scale-[.98] disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent"
          >
            <Gif aria-hidden="true" />
          </button>
        </span>
      </Tooltip>
      <div
        ref={popover}
        id={`gif-${id}`}
        popover="auto"
        role="dialog"
        aria-label={t("gif.picker")}
        style={{ positionAnchor: `--gif-${id}` }}
        onToggle={(e) => {
          const next = (e as unknown as ToggleEvent).newState === "open";
          setOpen(next);
          // focus goes back to the composer, unless the popover was dismissed by clicking somewhere that took the focus
          const held = document.activeElement;
          if (!next && (!held || held === document.body || held === trigger.current)) onClosed();
        }}
        className="m-0 w-88 max-w-[calc(100vw-2rem)] glass rounded-card p-2 text-ink [inset:auto] [bottom:calc(anchor(top)+8px)] [left:anchor(left)] [position-try-fallbacks:flip-block]"
      >
        {open && (
          <Content
            onPick={(g) => {
              popover.current?.hidePopover();
              onPick(g);
            }}
          />
        )}
      </div>
    </>
  );
}

function Content({ onPick }: { onPick: (gif: GifResult) => void }) {
  const model = useMemo(() => createGifPicker(gifApi(session.client.request)), []);
  const [state, setState] = useState(model.get());
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  const search = useRef<HTMLInputElement>(null);
  const grid = useId();

  useEffect(() => {
    const off = model.subscribe(() => setState(model.get()));
    model.start();
    search.current?.focus();
    return () => (off(), model.dispose());
  }, [model]);

  const { results, phase } = state;

  function onGridKey(e: KeyboardEvent) {
    const next = moveTile(active, e.key, results.length);
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    tiles.current[next]?.focus();
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={search}
        type="search"
        value={text}
        aria-label={t("gif.search")}
        aria-controls={grid}
        placeholder={t("gif.search")}
        maxLength={100}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          model.setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && results.length) (e.preventDefault(), tiles.current[0]?.focus());
        }}
        className="h-10 w-full rounded-control bg-surface-3 px-3 text-[15px] text-ink placeholder:text-ink-faint"
      />
      <div id={grid} role="group" aria-label={t("gif.results")} aria-busy={phase === "loading"} onKeyDown={onGridKey} className="grid max-h-72 min-h-24 grid-cols-2 content-start gap-1.5 overflow-y-auto">
        {results.map((g, i) => (
          <button
            key={g.id}
            ref={(el) => {
              tiles.current[i] = el;
            }}
            type="button"
            tabIndex={i === active ? 0 : -1}
            aria-label={t("gif.item", { title: g.title || t("gif.alt") })}
            onFocus={() => setActive(i)}
            onClick={() => onPick(g)}
            style={{ aspectRatio: `${g.width} / ${g.height}` }}
            className="block w-full overflow-hidden rounded-sm bg-surface-4 hover:brightness-110 focus-visible:outline-offset-[-2px]"
          >
            <img src={g.previewUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="size-full object-cover" />
          </button>
        ))}
      </div>
      <div aria-live="polite" className="text-center text-small text-ink-muted">
        {phase === "loading" && (
          <>
            <Spinner className="mx-auto size-5" />
            <span className="sr-only">{t("common.loading")}</span>
          </>
        )}
        {phase === "ready" && results.length === 0 && <p>{t("gif.empty")}</p>}
        {phase === "error" && (
          <p className="flex items-center justify-center gap-2">
            {t("gif.error")}
            <button type="button" onClick={model.retry} className="h-10 rounded-control px-3 font-medium text-moss-300 hover:bg-surface-4">
              {t("common.retry")}
            </button>
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="px-1 text-caption text-ink-faint">{t("gif.powered")}</p>
        {phase === "ready" && state.nextOffset !== null && (
          <button type="button" disabled={state.loadingMore} onClick={model.more} className="h-10 rounded-control px-3 text-small font-medium text-moss-300 hover:bg-surface-4 disabled:opacity-60">
            {state.loadingMore ? t("common.loading") : t("gif.more")}
          </button>
        )}
      </div>
    </div>
  );
}
