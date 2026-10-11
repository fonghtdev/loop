import { useId, useState, type ReactNode } from "react";
import { t } from "../i18n/t";
import { session } from "../lib/app";
import { Dialog } from "./Dialog";
import { FriendsArt, OrbitArt, TicketArt } from "./Illustrations";
import { CreateServerForm, JoinServerForm } from "./ServerRail";
import { ArtFrame } from "./States";

/** First run: a new account with no server and nobody to talk to. Three ways in; each opens the real flow. */
export function Welcome({ onAddFriend }: { onAddFriend: () => void }) {
  const name = session.useSession((s) => s.user?.username ?? "");
  const [dialog, setDialog] = useState<"create" | "join" | null>(null);
  return (
    <section aria-labelledby="welcome-title" className="animate-rise">
      <h2 id="welcome-title" className="font-display text-heading1 font-extrabold tracking-[-0.035em] text-balance min-[1280px]:text-display min-[1280px]:tracking-[-0.04em]">
        {t("welcome.title", { name })}
      </h2>
      <p className="mt-3 mb-6 max-w-[56ch] text-title text-ink-muted">{t("welcome.lead")}</p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <ActionCard art={<OrbitArt />} title={t("rail.createServer")} body={t("welcome.createBody")} onClick={() => setDialog("create")} />
        <ActionCard art={<TicketArt />} title={t("rail.joinServer")} body={t("welcome.joinBody")} onClick={() => setDialog("join")} />
        <ActionCard art={<FriendsArt />} title={t("friends.addTitle")} body={t("welcome.friendBody")} onClick={onAddFriend} />
      </div>
      <Dialog open={dialog === "create"} onClose={() => setDialog(null)} title={t("createServer.title")}>
        <CreateServerForm onDone={() => setDialog(null)} />
      </Dialog>
      <Dialog open={dialog === "join"} onClose={() => setDialog(null)} title={t("joinServer.title")}>
        <JoinServerForm onDone={() => setDialog(null)} />
      </Dialog>
    </section>
  );
}

function ActionCard({ art, title, body, onClick }: { art: ReactNode; title: string; body: string; onClick: () => void }) {
  const bodyId = useId();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      aria-describedby={bodyId}
      className="relative edge flex flex-col gap-1 rounded-panel bg-raise p-2 pb-5 text-left shadow-e2 transition-[translate,box-shadow] duration-(--duration-base) ease-(--ease-out-soft) hover:-translate-y-0.5 hover:shadow-e3"
    >
      <ArtFrame className="mb-3">{art}</ArtFrame>
      <span className="px-3 font-display text-title font-extrabold tracking-[-0.015em]">{title}</span>
      <span id={bodyId} className="px-3 text-small text-ink-muted">
        {body}
      </span>
    </button>
  );
}
