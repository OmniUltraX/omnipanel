import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { FormDialog, FormField } from "@/components/ui/form/FormDialog";
import { TextInput } from "@/components/ui/form/TextInput";
import { CodeEditor } from "@/components/ui/content/CodeEditor";
import { createBtPanelClient, type BtCrontabParams } from "@/lib/btpanel";
import { appConfirm } from "@/lib/appConfirm";
import { showToast } from "@/stores/toastStore";
import type { ServerEntry } from "./serverConnection";

type Props = {
  open: boolean;
  server: ServerEntry;
  editId?: number | null;
  onClose: () => void;
  onCreated?: () => void;
};

const CYCLE_TYPES = ["minute-n", "hour", "day", "day-n", "week", "month"] as const;
const S_TYPES = ["toShell", "toUrl"] as const;

const DANGEROUS_SCRIPT_RE =
  /\b(rm\s+-rf|mkfs|dd\s+if=|>\s*\/dev\/sd|drop\s+database|shutdown|reboot|format\s+[a-z]:)\b/i;

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  return String(value);
}

export function BtCreateCronjobDialog({
  open,
  server,
  editId = null,
  onClose,
  onCreated,
}: Props) {
  const { t } = useI18n();
  const isEdit = editId != null && editId > 0;

  const [name, setName] = useState("");
  const [cycleType, setCycleType] = useState<(typeof CYCLE_TYPES)[number]>("day");
  const [where1, setWhere1] = useState("1");
  const [hour, setHour] = useState("1");
  const [minute, setMinute] = useState("30");
  const [sType, setSType] = useState<(typeof S_TYPES)[number]>("toShell");
  const [sBody, setSBody] = useState("echo hello");
  const [remark, setRemark] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setName("");
    setCycleType("day");
    setWhere1("1");
    setHour("1");
    setMinute("30");
    setSType("toShell");
    setSBody("echo hello");
    setRemark("");
    setError(null);
    setBusy(false);
  }, []);

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  useEffect(() => {
    if (!open || !isEdit || editId == null) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const client = createBtPanelClient(server.address, server.key, server.id);
        const detail = await client.getCronDetail(editId);
        if (cancelled) return;
        setName(asString(detail.name));
        const nextType = asString(detail.type, "day");
        setCycleType(
          (CYCLE_TYPES as readonly string[]).includes(nextType)
            ? (nextType as (typeof CYCLE_TYPES)[number])
            : "day",
        );
        setWhere1(asString(detail.where1, "1"));
        setHour(asString(detail.where_hour ?? detail.hour, "1"));
        setMinute(asString(detail.where_minute ?? detail.minute, "30"));
        const nextSType = asString(detail.sType, "toShell");
        setSType(
          (S_TYPES as readonly string[]).includes(nextSType)
            ? (nextSType as (typeof S_TYPES)[number])
            : "toShell",
        );
        setSBody(asString(detail.sBody, "echo hello"));
        setRemark(asString(detail.sName ?? detail.ps));
      } catch (err) {
        if (!cancelled) setError(formatError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isEdit, editId, server.address, server.key]);

  const canSubmit = useMemo(() => {
    if (!name.trim() || !sBody.trim()) return false;
    if (cycleType === "minute-n" || cycleType === "day-n") {
      return Boolean(where1.trim());
    }
    return true;
  }, [name, sBody, cycleType, where1]);

  const buildParams = (): BtCrontabParams => ({
    name: name.trim(),
    type: cycleType,
    where1: where1.trim() || "1",
    sType,
    sBody: sBody.trim(),
    sName: remark.trim(),
    hour,
    minute,
    save: 0,
    backupTo: "localhost",
  });

  const handleSubmit = async () => {
    if (!canSubmit) {
      setError(t("server.create.cronjob.required"));
      return;
    }
    if (sType === "toShell" && DANGEROUS_SCRIPT_RE.test(sBody)) {
      const ok = await appConfirm(
        t("server.create.cronjob.scriptDangerConfirm"),
        t("common.confirm"),
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = createBtPanelClient(server.address, server.key, server.id);
      if (isEdit && editId != null) {
        await client.modifyCrontab(editId, buildParams());
        showToast(t("server.cronjobs.editSuccess"));
      } else {
        await client.addCrontab(buildParams());
        showToast(t("server.create.cronjob.success"));
      }
      reset();
      onClose();
      onCreated?.();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={handleClose}
      title={isEdit ? t("server.cronjobs.editTitle") : t("server.create.cronjob.title")}
      size="lg"
      cancelDisabled={busy}
      closeDisabled={busy}
      primaryAction={{
        label: busy ? t("common.saving") : t("common.confirm"),
        disabled: busy || loading || !canSubmit,
        onClick: () => void handleSubmit(),
      }}
      status={error ? { kind: "error", message: error } : null}
    >
      {loading ? <p className="form-hint">{t("common.loading")}</p> : null}
      <FormField label={t("server.create.cronjob.name")}>
        <TextInput value={name} onChange={setName} disabled={busy} />
      </FormField>
      <div className="server-create-website-domain-row">
        <FormField label={t("server.create.cronjob.btCycle")}>
          <select
            className="input"
            value={cycleType}
            disabled={busy}
            onChange={(e) => setCycleType(e.target.value as (typeof CYCLE_TYPES)[number])}
          >
            {CYCLE_TYPES.map((item) => (
              <option key={item} value={item}>
                {t(`server.create.cronjob.btCycles.${item}` as "server.create.cronjob.btCycles.day")}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={t("server.create.cronjob.btType")}>
          <select
            className="input"
            value={sType}
            disabled={busy || isEdit}
            onChange={(e) => setSType(e.target.value as (typeof S_TYPES)[number])}
          >
            <option value="toShell">{t("server.create.cronjob.btTypeShell")}</option>
            <option value="toUrl">{t("server.create.cronjob.btTypeUrl")}</option>
          </select>
        </FormField>
      </div>
      {(cycleType === "minute-n" || cycleType === "day-n") && (
        <FormField label={t("server.create.cronjob.btWhere1")}>
          <TextInput value={where1} onChange={setWhere1} disabled={busy} />
        </FormField>
      )}
      {(cycleType === "day" || cycleType === "day-n" || cycleType === "week" || cycleType === "month") && (
        <div className="server-create-website-domain-row">
          <FormField label={t("server.create.cronjob.btHour")}>
            <TextInput value={hour} onChange={setHour} disabled={busy} />
          </FormField>
          <FormField label={t("server.create.cronjob.btMinute")}>
            <TextInput value={minute} onChange={setMinute} disabled={busy} />
          </FormField>
        </div>
      )}
      <FormField
        label={
          sType === "toUrl"
            ? t("server.create.cronjob.url")
            : t("server.create.cronjob.script")
        }
      >
        <CodeEditor
          value={sBody}
          onChange={setSBody}
          language={sType === "toUrl" ? "text" : "shell"}
          height={160}
          readOnly={busy}
        />
      </FormField>
      <FormField label={t("server.create.remark")}>
        <TextInput
          value={remark}
          onChange={setRemark}
          placeholder={t("server.create.remarkPlaceholder")}
          disabled={busy}
        />
      </FormField>
    </FormDialog>
  );
}
