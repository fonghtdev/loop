import { MagnifyingGlass } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { chat, session } from "../lib/app";
import type { Message } from "../lib/chat";
import { arrowNav } from "../lib/focus";
import { useDisplayName } from "../lib/identity-hooks";
import { createSearch, hitKey, jumpPlan, normalizeQuery, pendingJump, snippet, type SearchScope, type SearchState } from "../lib/search";
import { fullTimestamp } from "../lib/timeline";
import { useNav } from "../lib/nav";
import { toast } from "../lib/toast";
import type { ConvKey } from "../lib/conversation";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import { LoadError } from "./States";

type Props = {
  scope: SearchScope;
  /** The conversation on screen: a result in it is scrolled to when loaded. */
  convKey: ConvKey;
  /** `#name` of a channel of this server, for the result rows. */
  channelName: (channelId: string) => string | undefined;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Scrolls the open list to the message; false when it is not loaded. */
  onGoto: (id: string) => boolean;
};

/** The search box of the chat header and the panel of results under it (Esc closes, Ctrl+F focuses the box). */
export function SearchPanel({ scope, convKey, channelName, inputRef, onGoto }: Props) {
  const scopeKey = scope.kind === "dm" ? `dm:${scope.dmId}` : `guild:${scope.guildId}`;
  const search = useMemo(() => createSearch({ request: session.client.request, scope }), [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => search.reset(), [search, convKey]);
  const s = useStore(search.store);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const valid = normalizeQuery(s.query) !== null;
  const showPanel = open && s.query.trim() !== "";

  const close = () => {
    setOpen(false);
    search.reset();
    inputRef.current?.blur();
  };
  const pick = (m: Message) => {
    const plan = jumpPlan(hitKey(m), convKey, !!chat.get(convKey).messages.some((x) => x.id === m.id));
    close();
    if (plan === "scroll") onGoto(m.id);
    else if (plan === "outside") toast.push(t("search.outside"));
    else {
      pendingJump.set(hitKey(m), m.id);
      useNav.setState({ channelId: m.channelId, settings: null });
    }
  };
  const inputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) void search.submit();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      document.querySelector<HTMLElement>(`#${CSS.escape(panelId)} [data-nav-item]`)?.focus();
    }
  };

  return (
    <div
      role="search"
      className="relative"
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}
      onKeyDown={(e) => e.key === "Escape" && !e.nativeEvent.isComposing && (e.stopPropagation(), close())}
    >
      <label className="flex h-10 items-center gap-2 rounded-control bg-surface-3 pr-2 pl-3 text-ink-muted focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-cosmic-300">
        <MagnifyingGlass aria-hidden="true" className="shrink-0" />
        <input
          ref={inputRef}
          type="search"
          aria-label={t("search.label")}
          aria-expanded={showPanel}
          aria-controls={showPanel ? panelId : undefined}
          aria-keyshortcuts="Control+F Meta+F"
          placeholder={t("search.placeholder")}
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          value={s.query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setOpen(true);
            search.setQuery(e.target.value);
          }}
          onKeyDown={inputKey}
          className="w-36 min-w-0 bg-transparent text-small font-normal text-ink transition-[width] duration-(--duration-base) placeholder:text-ink-faint focus:w-56 focus-visible:outline-none"
        />
      </label>
      {showPanel && (
        <div id={panelId} onKeyDown={arrowNav} className="absolute top-[calc(100%+4px)] right-0 z-30 flex max-h-[60vh] w-[min(440px,90vw)] flex-col overflow-y-auto glass rounded-card p-1.5 text-ink">
          <h2 className="px-2.5 pt-1.5 pb-2 font-display text-[15px] font-bold">{t("search.title")}</h2>
          <Results state={s} valid={valid} channelName={channelName} onPick={pick} onRetry={() => void search.submit()} onMore={() => void search.loadMore()} />
          <p aria-live="polite" className="sr-only">
            {s.status === "ready" ? t("search.results", { count: String(s.results.length) }) : ""}
          </p>
        </div>
      )}
    </div>
  );
}

function Results({ state: s, valid, channelName, onPick, onRetry, onMore }: { state: SearchState; valid: boolean; channelName: Props["channelName"]; onPick: (m: Message) => void; onRetry: () => void; onMore: () => void }) {
  if (!valid) return <p className="px-2.5 pb-3 text-sm text-ink-muted">{t("search.invalid")}</p>;
  if (s.status === "error") return <LoadError message={t("search.failed")} onRetry={onRetry} />;
  if (s.status !== "ready") return <div role="status" aria-label={t("common.loading")} className="grid h-24 place-items-center"><Spinner className="size-5 text-ink-faint" /></div>;
  if (!s.results.length)
    return (
      <div className="px-2.5 pb-3 text-sm text-ink-muted">
        <p className="font-medium text-ink">{t("search.empty")}</p>
        <p className="mt-1">{t("search.emptyHint")}</p>
      </div>
    );
  return (
    <>
      <ul className="flex flex-col gap-1">
        {s.results.map((m) => (
          <Hit key={m.id} message={m} query={s.query} channel={m.channelId ? channelName(m.channelId) : undefined} onPick={() => onPick(m)} />
        ))}
      </ul>
      {s.moreFailed && <p className="px-2.5 pt-2 text-sm text-danger">{t("search.moreFailed")}</p>}
      {s.hasMore && (
        <Button variant="ghost" data-nav-item disabled={s.loadingMore} onClick={onMore} className="mt-1 h-10 self-start px-3 text-sm">
          {s.loadingMore ? <Spinner className="size-4" /> : null}
          {t("search.more")}
        </Button>
      )}
    </>
  );
}

function Hit({ message: m, query, channel, onPick }: { message: Message; query: string; channel: string | undefined; onPick: () => void }) {
  const name = useDisplayName(m.author.id, m.author.username);
  const parts = m.content ? snippet(m.content, query) : [{ text: m.attachments.map((a) => a.filename).join(", "), hit: false }];
  return (
    <li>
      <button type="button" data-nav-item onClick={onPick} className="block w-full rounded-control bg-surface-3 px-3 py-2 text-left hover:bg-surface-4 focus-visible:outline-offset-[-2px]">
        <span className="flex items-baseline gap-2 text-sm leading-5">
          <span className="min-w-0 truncate font-semibold">{name}</span>
          {channel && <span className="shrink-0 text-caption text-ink-muted">#{channel}</span>}
          <time dateTime={m.createdAt} className="numeric ml-auto shrink-0 text-caption text-ink-faint">
            {fullTimestamp(m.createdAt)}
          </time>
        </span>
        <span className="mt-0.5 line-clamp-3 block text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-ink-muted">
          {parts.map((p, i) =>
            p.hit ? (
              <mark key={i} className="rounded-xs bg-cosmic-wash font-bold text-cosmic-200">
                {p.text}
              </mark>
            ) : (
              p.text
            ),
          )}
        </span>
      </button>
    </li>
  );
}
