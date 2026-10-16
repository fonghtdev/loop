import { PushPin, PushPinSlash } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { chat, queryClient, session } from "../lib/app";
import type { Message } from "../lib/chat";
import { parseKey, type ConvKey } from "../lib/conversation";
import { errorMessage } from "../lib/errors";
import { useDisplayName } from "../lib/identity-hooks";
import { pinRows, pinsPath } from "../lib/pins";
import { profiles } from "../lib/profiles";
import { toast } from "../lib/toast";
import { fullTimestamp } from "../lib/timeline";
import { Button } from "./Button";
import { MessageText } from "./MessageText";
import { RowMenu } from "./RowMenu";
import { Spinner } from "./Spinner";
import { LoadError } from "./States";

type Props = { convKey: ConvKey; guildId: string | null; canUnpin: boolean; /** Scrolls the open list to the message; false when it is not loaded. */ onGoto: (id: string) => boolean };

/** The header button and the popover listing the conversation's pinned messages (newest pin first); fetched at the first open, kept live by the pin events. */
export function PinsPanel(props: Props) {
  const [opened, setOpened] = useState(false);
  return (
    <RowMenu id={`pins-${parseKey(props.convKey).id}`} label={t("pin.panel")} trigger={<PushPin aria-hidden="true" />} width="w-[min(440px,90vw)]" onOpen={() => setOpened(true)}>
      {(close) => <PinsList {...props} opened={opened} close={close} />}
    </RowMenu>
  );
}

function PinsList({ convKey, guildId, canUnpin, onGoto, opened, close }: Props & { opened: boolean; close: () => void }) {
  const live = useStore(chat.store, (s) => s.convs[convKey]?.messages);
  const pins = useQuery({
    queryKey: ["pins", convKey],
    enabled: opened,
    queryFn: async () => {
      const res = await session.client.request<{ messages: Message[] }>("GET", pinsPath(convKey));
      profiles.seed(res.messages.map((m) => m.author), null);
      return res.messages;
    },
  });
  const unpin = (id: string) =>
    void chat
      .pin(convKey, id, false)
      .then(() => queryClient.invalidateQueries({ queryKey: ["pins", convKey] }))
      .catch((err) => toast.push(errorMessage(err), "error"));

  if (pins.isPending) return <div className="grid h-24 place-items-center"><Spinner className="size-5 text-ink-faint" /></div>;
  if (pins.isError) return <LoadError message={t("pin.loadFailed")} onRetry={() => void pins.refetch()} />;
  const rows = pinRows(pins.data, live ?? []);
  return (
    <div className="flex max-h-[60vh] flex-col overflow-y-auto">
      <h2 className="px-2.5 pt-1.5 pb-2 font-display text-[15px] font-bold">{t("pin.panelTitle")}</h2>
      {rows.length === 0 ? (
        <div className="px-2.5 pb-3 text-sm text-ink-muted">
          <p className="font-medium text-ink">{t("pin.empty")}</p>
          <p className="mt-1">{t("pin.emptyHint")}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map(({ message, loaded }) => (
            <PinItem key={message.id} message={message} guildId={guildId} canGoto={loaded} canUnpin={canUnpin} onGoto={() => onGoto(message.id) && close()} onUnpin={() => unpin(message.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PinItem({ message, guildId, canGoto, canUnpin, onGoto, onUnpin }: { message: Message; guildId: string | null; canGoto: boolean; canUnpin: boolean; onGoto: () => void; onUnpin: () => void }) {
  const name = useDisplayName(message.author.id, message.author.username);
  return (
    <li className="rounded-control bg-surface-3 px-3 py-2">
      <p className="flex items-baseline gap-2 text-sm leading-5">
        <span className="min-w-0 truncate font-semibold">{name}</span>
        <time dateTime={message.createdAt} className="numeric shrink-0 text-caption text-ink-faint">
          {fullTimestamp(message.createdAt)}
        </time>
      </p>
      <div className="max-h-40 overflow-y-auto">
        {message.content ? <MessageText content={message.content} guildId={guildId} /> : <p className="text-sm text-ink-muted">{message.attachments.map((a) => a.filename).join(", ")}</p>}
      </div>
      <div className="mt-1 flex gap-1">
        {canGoto && (
          <Button variant="ghost" data-nav-item onClick={onGoto} className="h-10 px-3 text-sm">
            {t("pin.goto")}
          </Button>
        )}
        {canUnpin && (
          <Button variant="ghost" data-nav-item onClick={onUnpin} className="h-10 px-3 text-sm">
            <PushPinSlash aria-hidden="true" />
            {t("pin.remove")}
          </Button>
        )}
      </div>
    </li>
  );
}
