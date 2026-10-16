import { type AutoModRuleDto, MAX_AUTOMOD_KEYWORDS, MAX_AUTOMOD_RULES } from "@loop/shared";
import { PencilSimple, Trash } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { t } from "../i18n/t";
import type { SettingsCtx } from "../lib/admin";
import { admin } from "../lib/app";
import { canAddRule, draftOf, parseKeywords, ruleFormErrors, rulePatch, type RuleDraft } from "../lib/automod";
import { errorMessage } from "../lib/errors";
import { toast } from "../lib/toast";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { ConfirmBody } from "./Confirm";
import { Dialog, DialogActions, DialogError } from "./Dialog";
import { LoadError, Skeleton } from "./States";
import { Switch } from "./Switch";
import { TextField } from "./TextField";

/** Under ["guild", id] so every admin call's refetch includes it. */
export const autoModKey = (guildId: string) => ["guild", guildId, "automod"];

/** AutoMod keyword rules (owner / ADMINISTRATOR only, gated by settingsSections): list, enable switch, create / edit dialog, delete confirm. */
export function AutoModPanel({ ctx }: { ctx: SettingsCtx }) {
  const rules = useQuery({ queryKey: autoModKey(ctx.guildId), queryFn: () => admin.listAutoMod(ctx.guildId) });
  const [editing, setEditing] = useState<AutoModRuleDto | "new" | null>(null);
  const [deleting, setDeleting] = useState<AutoModRuleDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const count = rules.data?.length ?? 0;

  async function toggle(r: AutoModRuleDto, enabled: boolean) {
    setBusy(r.id);
    try {
      await admin.updateAutoMod(ctx.guildId, r.id, { enabled });
    } catch (e) {
      toast.push(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <p className="text-sm text-ink-muted">{t("automod.intro")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => setEditing("new")} disabled={!rules.data || !canAddRule(count)} aria-describedby="automod-limit">
          {t("automod.create")}
        </Button>
        <p id="automod-limit" className="text-caption text-ink-muted">
          {t("automod.limit", { max: String(MAX_AUTOMOD_RULES) })}
        </p>
      </div>
      {rules.isError && <LoadError message={errorMessage(rules.error)} onRetry={() => void rules.refetch()} />}
      {rules.isPending && <Skeleton rows={2} />}
      {rules.data?.length === 0 && <p className="relative edge rounded-panel bg-raise p-4 text-sm text-ink-muted shadow-e2">{t("automod.empty")}</p>}
      {!!rules.data?.length && (
        <ul aria-label={t("automod.list")} className="relative edge flex flex-col gap-0.5 rounded-panel bg-raise p-2 shadow-e2">
          {rules.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-control px-1 py-1">
              <div className="min-w-0 flex-1">
                <Switch label={t("automod.enabled", { name: r.name })} description={t("automod.keywordCount", { count: String(r.keywords.length) })} checked={r.enabled} disabled={busy === r.id} onChange={(on) => void toggle(r, on)} />
              </div>
              <IconButton icon={<PencilSimple />} label={t("automod.editLabel", { name: r.name })} tip={t("automod.edit")} onClick={() => setEditing(r)} />
              <IconButton icon={<Trash />} label={t("automod.deleteLabel", { name: r.name })} tip={t("automod.delete")} danger onClick={() => setDeleting(r)} />
            </li>
          ))}
        </ul>
      )}
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={t(editing === "new" ? "automod.formTitleNew" : "automod.formTitleEdit")}>
        {editing !== null && <RuleForm ctx={ctx} rule={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />}
      </Dialog>
      <Dialog open={!!deleting} onClose={() => setDeleting(null)} title={t("automod.deleteTitle", { name: deleting?.name ?? "" })}>
        {deleting && (
          <ConfirmBody
            body={t("automod.deleteBody")}
            submit={t("automod.delete")}
            onDone={() => setDeleting(null)}
            action={async () => {
              await admin.deleteAutoMod(ctx.guildId, deleting.id);
              toast.push(t("automod.deleted"));
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

/** Name, keywords (one per line, live count and the first bad line), enabled. Errors show after the first save attempt, then live. */
function RuleForm({ ctx, rule, onDone }: { ctx: SettingsCtx; rule?: AutoModRuleDto; onDone: () => void }) {
  const [draft, setDraft] = useState<RuleDraft>(() => draftOf(rule));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const areaId = useId();
  const errors = ruleFormErrors(draft);
  const set = (patch: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...patch }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!errors.ok || busy) return;
    setBusy(true);
    setError("");
    try {
      if (rule) {
        const patch = rulePatch(rule, draft);
        if (patch) await admin.updateAutoMod(ctx.guildId, rule.id, patch);
      } else {
        await admin.createAutoMod(ctx.guildId, { name: draft.name.trim(), keywords: parseKeywords(draft.keywords), enabled: draft.enabled });
      }
      toast.push(t("automod.saved"));
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const keywordsError = tried ? errors.keywords : undefined;
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <TextField label={t("automod.name")} value={draft.name} onChange={(e) => set({ name: e.target.value })} error={tried ? errors.name : undefined} autoFocus />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={areaId} className="text-sm font-medium text-ink">
          {t("automod.keywords")}
        </label>
        <textarea
          id={areaId}
          value={draft.keywords}
          onChange={(e) => set({ keywords: e.target.value })}
          rows={8}
          aria-invalid={keywordsError ? true : undefined}
          aria-describedby={`${areaId}-hint ${areaId}-count ${areaId}-error`}
          className={`min-h-32 w-full resize-y rounded-control border bg-surface-3 px-3.5 py-2 text-[15px] leading-6 text-ink ${keywordsError ? "border-danger" : "border-line-strong focus-visible:border-cosmic-300"}`}
        />
        <p id={`${areaId}-hint`} className="text-caption text-ink-muted">
          {t("automod.keywordsHint")}
        </p>
        <p id={`${areaId}-count`} aria-live="polite" className={`numeric text-caption ${errors.count > MAX_AUTOMOD_KEYWORDS ? "text-danger" : "text-ink-muted"}`}>
          {t("automod.counter", { count: String(errors.count), max: String(MAX_AUTOMOD_KEYWORDS) })}
        </p>
        <p id={`${areaId}-error`} aria-live="polite" className="text-[13px] font-medium text-danger">
          {keywordsError}
        </p>
      </div>
      <Switch label={t("automod.enable")} checked={draft.enabled} onChange={(on) => set({ enabled: on })} />
      {error && <DialogError message={error} />}
      <DialogActions>
        <Button type="submit" loading={busy}>
          {t("automod.save")}
        </Button>
      </DialogActions>
    </form>
  );
}
