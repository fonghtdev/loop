import { useMemo } from "react";
import { wholeGifUrl } from "@loop/shared";
import { t } from "../i18n/t";
import { session } from "../lib/app";
import { useShowGifs } from "../lib/gifs";
import { useMentionName } from "../lib/mention-hooks";
import { GifImage } from "./GifImage";
import { Tooltip } from "./Tooltip";
import { UserCardTrigger } from "./UserCard";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown";

/** `@name` as a moss-tinted chip that opens the user's card; an id nobody told us about stays an inert "@unknown". */
function Mention({ id, guildId }: { id: string; guildId: string | null }) {
  const name = useMentionName(guildId)(id);
  const mine = session.useSession((s) => s.user?.id) === id;
  const tint = mine ? "bg-[rgb(180_208_140/.28)] text-moss-100" : "bg-[rgb(180_208_140/.14)] text-moss-200 hover:bg-[rgb(180_208_140/.26)]";
  if (name === undefined) return <span className="rounded-xs bg-surface-3 px-1 text-ink-muted">@{t("mention.unknown")}</span>;
  return (
    <UserCardTrigger user={{ id, username: name }} guildId={guildId} className={`inline rounded-xs px-1 font-medium ${tint}`}>
      @{name}
    </UserCardTrigger>
  );
}

function Inlines({ nodes, guildId }: { nodes: Inline[]; guildId: string | null }) {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "mention":
        return <Mention key={i} id={n.id} guildId={guildId} />;
      case "text":
        return <span key={i}>{n.text}</span>;
      case "code":
        return (
          <code key={i} className="rounded-xs bg-surface-3 px-1 py-px font-mono text-[.9em]">
            {n.text}
          </code>
        );
      case "strong":
        return (
          <strong key={i} className="font-bold">
            <Inlines nodes={n.children} guildId={guildId} />
          </strong>
        );
      case "em":
        return (
          <em key={i}>
            <Inlines nodes={n.children} guildId={guildId} />
          </em>
        );
      case "del":
        return (
          <del key={i}>
            <Inlines nodes={n.children} guildId={guildId} />
          </del>
        );
      case "link":
        return (
          // the tooltip shows where the link really goes (the label may say anything)
          <Tooltip key={i} label={n.href}>
            <a
              href={n.href}
              onClick={(e) => {
                e.preventDefault(); // never navigate the window: links open in the OS browser
                void window.loop.openExternal(n.href);
              }}
              className="text-moss-300 underline underline-offset-2 hover:text-moss-200"
            >
              <Inlines nodes={n.children} guildId={guildId} />
            </a>
          </Tooltip>
        );
    }
  });
}

const TEXT = "max-w-[68ch] text-(length:--m-fs) leading-(--m-lh) whitespace-pre-wrap text-ink [overflow-wrap:anywhere] select-text";

function BlockView({ block, guildId }: { block: Block; guildId: string | null }) {
  switch (block.t) {
    case "p":
      return (
        <p className={TEXT}>
          <Inlines nodes={block.children} guildId={guildId} />
        </p>
      );
    case "quote":
      return (
        <blockquote className={`${TEXT} border-l-[3px] border-line-strong pl-3 text-ink-muted`}>
          <Inlines nodes={block.children} guildId={guildId} />
        </blockquote>
      );
    case "code":
      return (
        <figure className="max-w-[68ch] overflow-hidden rounded-control border border-line bg-surface-0 select-text">
          {block.lang && <figcaption className="border-b border-line px-3 py-1 text-caption text-ink-muted">{block.lang}</figcaption>}
          <pre className="overflow-x-auto px-3 py-2 font-mono text-small leading-5 text-ink">
            <code>{block.text}</code>
          </pre>
        </figure>
      );
  }
}

/** A message's text with the formatting the parser found (see lib/markdown.ts); plain text keeps the old single paragraph. */
/** `guildId`: the server whose members name the mentions (null at Home). */
export function MessageText({ content, guildId = null }: { content: string; guildId?: string | null }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const showGifs = useShowGifs();
  const gif = showGifs ? wholeGifUrl(content) : null;
  if (gif) return <GifImage url={gif} />;
  if (blocks.length === 1 && blocks[0]!.t === "p") return <BlockView block={blocks[0]!} guildId={guildId} />;
  return (
    <div className="flex flex-col gap-1">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} guildId={guildId} />
      ))}
    </div>
  );
}
