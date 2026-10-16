import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { typing } from "../lib/app";
import { parseKey, type ConvKey } from "../lib/conversation";
import { useNav } from "../lib/nav";
import { useMentionName } from "../lib/mention-hooks";
import { typingText } from "../lib/typing";

/** Screen readers hear the line only after it has settled this long, so a chatty channel does not talk over the reader. */
const ANNOUNCE_AFTER_MS = 1_500;
const EMPTY: string[] = [];

/** "A đang gõ..." above the composer: one line whose height is always reserved, so the list never jumps. */
export function TypingIndicator({ convKey }: { convKey: ConvKey }) {
  const typers = useStore(typing.store, (s) => s.typers[convKey] ?? EMPTY);
  const guildId = useNav((s) => (parseKey(convKey).kind === "channel" ? s.guildId : null));
  const nameOf = useMentionName(guildId);
  const names = typers.map(nameOf);
  const known = names.filter((n): n is string => !!n);
  const text = known.length === names.length ? typingText(known) : t("typing.many"); // a typer we cannot name: the generic line
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(text), ANNOUNCE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <>
      <p aria-hidden="true" className="min-w-0 truncate text-caption text-ink-muted">
        {text}
      </p>
      <p aria-live="polite" className="sr-only">
        {announced}
      </p>
    </>
  );
}
