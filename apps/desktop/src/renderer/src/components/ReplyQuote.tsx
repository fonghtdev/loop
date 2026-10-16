import { ArrowBendUpLeft } from "@phosphor-icons/react";
import { t } from "../i18n/t";
import type { ReplyTo } from "../lib/chat";
import { Tooltip } from "./Tooltip";
import { useDisplayName } from "../lib/identity-hooks";
import { useMentionName } from "../lib/mention-hooks";
import { readable } from "../lib/mentions";
import { useNav } from "../lib/nav";

const QUOTE = "mb-0.5 flex min-h-6 max-w-full min-w-0 items-center gap-1.5 text-left text-small text-ink-muted";

/** The compact line above a reply: who and the start of what it answers. Click scrolls to the original when it is loaded. */
export function ReplyQuote({ reply, onJump }: { reply: ReplyTo; onJump: (id: string) => void }) {
  if (reply.deleted)
    return (
      <p className={`${QUOTE} italic`}>
        <ArrowBendUpLeft aria-hidden="true" className="shrink-0" />
        {t("reply.deleted")}
      </p>
    );
  return <LiveQuote reply={reply} onJump={onJump} />;
}

function LiveQuote({ reply, onJump }: { reply: Extract<ReplyTo, { deleted: false }>; onJump: (id: string) => void }) {
  const name = useDisplayName(reply.author.id, reply.author.username);
  const mentionName = useMentionName(useNav((s) => s.guildId));
  return (
    <Tooltip label={t("reply.quoteOf", { name })}>
      <button type="button" onClick={() => onJump(reply.id)} className={`${QUOTE} rounded-xs hover:text-ink`}>
        <ArrowBendUpLeft aria-hidden="true" className="shrink-0" />
        <span className="shrink-0 font-semibold">{name}</span>
        <span className="truncate">{readable(reply.content, mentionName) || t("reply.attachment")}</span>
      </button>
    </Tooltip>
  );
}
