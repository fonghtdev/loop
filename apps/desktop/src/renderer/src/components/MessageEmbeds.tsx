import { X } from "@phosphor-icons/react";
import { useState } from "react";
import type { MessageEmbed } from "@loop/shared";
import { t } from "../i18n/t";
import { embedCards, embedHides, useHiddenEmbeds, useLinkPreviews, type EmbedCard } from "../lib/embeds";
import { Tooltip } from "./Tooltip";

/**
 * Link previews under a message's text (server-made, see lib/embeds). Text only, never HTML; the link opens in the
 * OS browser and its tooltip shows the real URL; the thumbnail sits in a fixed 80x80 box, so loading it never moves
 * the list. The "x" hides the card on this device only.
 */
export function MessageEmbeds({ messageId, embeds }: { messageId: string; embeds: MessageEmbed[] | undefined }) {
  const enabled = useLinkPreviews();
  const hidden = useHiddenEmbeds();
  const cards = embedCards(messageId, embeds, { enabled, hidden });
  if (!cards.length) return null;
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {cards.map((c) => (
        <Card key={c.key} card={c} />
      ))}
    </div>
  );
}

function Card({ card }: { card: EmbedCard }) {
  const [broken, setBroken] = useState(false);
  return (
    <div role="group" aria-label={t("embed.label", { site: card.siteName })} className="edge relative flex max-w-[440px] gap-3 rounded-card border-l-4 border-moss-500 bg-raise py-2.5 pr-11 pl-3 shadow-e1">
      <div className="min-w-0 flex-1">
        <p className="truncate text-caption text-ink-faint">{card.siteName}</p>
        <Tooltip label={card.url}>
          <a
            href={card.url}
            onClick={(e) => {
              e.preventDefault(); // never navigate the window
              void window.loop.openExternal(card.url);
            }}
            className="line-clamp-2 font-semibold break-words text-moss-300 hover:text-moss-200 hover:underline"
          >
            {card.title ?? card.siteName}
          </a>
        </Tooltip>
        {card.description && <p className="mt-0.5 line-clamp-3 text-small break-words text-ink-muted">{card.description}</p>}
      </div>
      {card.thumbnail && (
        <div className="size-20 shrink-0 self-start overflow-hidden rounded-sm bg-surface-4">
          {!broken && <img src={card.thumbnail} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="size-full object-cover" />}
        </div>
      )}
      <Tooltip label={t("embed.hide")}>
        <button
          type="button"
          aria-label={t("embed.hide")}
          onClick={() => embedHides.hide(card.key)}
          className="absolute top-0.5 right-0.5 grid size-10 place-items-center rounded-control text-ink-faint hover:bg-surface-4 hover:text-ink"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </Tooltip>
    </div>
  );
}
