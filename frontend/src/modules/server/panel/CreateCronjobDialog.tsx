import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { FormDialog, FormField } from "@/components/ui/form/FormDialog";
import { TextInput } from "@/components/ui/form/TextInput";
import { CodeEditor } from "@/components/ui/content/CodeEditor";
import {
  createOnePanelClient,
  type OnePanelCronjobCreate,
  type OnePanelCronjobType,
  type OnePanelCronjobUpdate,
  type OnePanelGroup,
} from "@/lib/onepanel";
import { showToast } from "@/stores/toastStore";
import type { ServerEntry } from "./serverConnection";

const CRONJOB_TYPES: OnePanelCronjobType[] = ["shell", "curl", "clean", "ntp"];
const EXECUTORS = ["bash", "sh", "python", "python3"] as const;

function scriptLanguageForExecutor(executor: string): "shell" | "python" {
  return executor.startsWith("python") ? "python" : "shell";
}

function defaultSpecForType(type: OnePanelCronjobType): string {
  switch (type) {
    case "ntp":
      return "30 1 * * *";
    case "shell":
    case "curl":
    case "clean":
    default:
      return "30 1 * * 1";
  }
}

type CreateCronjobDialogProps = {
  open: boolean;
  server: ServerEntry;
  /** 传入时进入编辑模式（POST /cronjobs/update） */
  editId?: number | null;
  onClose: () => void;
  onCreated?: () => void;
};

function formatCreateError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  return String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isCronjobType(value: string): value is OnePanelCronjobType {
  return (CRONJOB_TYPES as string[]).includes(value);
}

export function CreateCronjobDialog({
  open,
  server,
  editId = null,
  onClose,
  onCreated,
}: CreateCronjobDialogProps) {
  const { t } = useI18n();
  const isEdit = editId != null && editId > 0;

  const [type, setType] = useState<OnePanelCronjobType>("shell");
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState(0);
  const [spec, setSpec] = useState(defaultSpecForType("shell"));
  const [timeout, setTimeoutSec] = useState(3600);
  const [retryTimes, setRetryTimes] = useState(0);

  // shell
  const [executor, setExecutor] = useState<string>("bash");
  const [script, setScript] = useState("#!/bin/bash\necho hello");

  // curl
  const [url, setUrl] = useState("");

  const [groups, setGroups] = useState<OnePanelGroup[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setType("shell");
    setName("");
    setGroupId(0);
    setSpec(defaultSpecForType("shell"));
    setTimeoutSec(3600);
    setRetryTimes(0);
    setExecutor("bash");
    setScript("#!/bin/bash\necho hello");
    setUrl("");
    setError(null);
    setBusy(false);
  }, []);

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const handleTypeChange = (next: OnePanelCronjobType) => {
    if (isEdit) return;
    setType(next);
    setSpec(defaultSpecForType(next));
  };

  useEffect(() => {
    if (!open || server.serviceType !== "1panel") return;
    let cancelled = false;
    setOptionsLoading(true);
    void (async () => {
      try {
        const client = createOnePanelClient(server.address, server.key);
        const groupList = await client.searchGroups("cronjob").catch(() => [] as OnePanelGroup[]);
        if (cancelled) return;
        setGroups(groupList);
        const defaultGroup =
          groupList.find((g) => g.isDefault) ??
          groupList.find((g) => g.name === "Default") ??
          groupList[0];

        if (isEdit && editId != null) {
          const detail = await client.loadCronjobInfo(editId);
          if (cancelled) return;
          const nextTypeRaw = asString(detail.type, "shell");
          const nextType = isCronjobType(nextTypeRaw) ? nextTypeRaw : "shell";
          setType(nextType);
          setName(asString(detail.name));
          setGroupId(asNumber(detail.groupID ?? detail.groupId, defaultGroup?.id ?? 0));
          setSpec(asString(detail.spec, defaultSpecForType(nextType)));
          setTimeoutSec(asNumber(detail.timeout, 3600));
          setRetryTimes(asNumber(detail.retryTimes, 0));
          setExecutor(asString(detail.executor, "bash") || "bash");
          setScript(asString(detail.script, "#!/bin/bash\necho hello"));
          setUrl(asString(detail.url));
        } else {
          setGroupId(defaultGroup?.id ?? 0);
        }
      } catch (err) {
        if (!cancelled) setError(formatCreateError(err));
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, server, isEdit, editId]);

  const canSubmit = useMemo(() => {
    if (!name.trim() || !spec.trim()) return false;
    if (timeout < 1) return false;
    if (retryTimes < 0) return false;
    if (type === "shell") return Boolean(script.trim() && executor);
    if (type === "curl") return Boolean(url.trim());
    return true;
  }, [name, spec, timeout, retryTimes, type, script, executor, url]);

  const buildBody = (): OnePanelCronjobCreate => {
    const body: OnePanelCronjobCreate = {
      name: name.trim(),
      type,
      groupID: groupId || 0,
      specCustom: true,
      spec: spec.trim(),
      retainCopies: 7,
      retryTimes,
      timeout,
      ignoreErr: false,
      secret: "",
      alertCount: 0,
      alertTitle: "",
      alertMethod: "",
      scriptID: 0,
      appID: "",
      website: "",
      exclusionRules: "",
      dbType: "",
      dbName: "",
      url: "",
      isDir: false,
      sourceDir: "",
      sourceAccountIDs: "",
      downloadAccountID: 0,
      executor: "",
      scriptMode: "",
      script: "",
      command: "",
      containerName: "",
      user: "",
    };

    if (type === "shell") {
      body.executor = executor;
      body.scriptMode = "input";
      body.script = script.trim();
    } else if (type === "curl") {
      body.url = url.trim();
    }

    return body;
  };

  const handleSubmit = async () => {
    if (server.serviceType !== "1panel") {
      setError(t("server.create.onePanelOnly"));
      return;
    }
    if (!canSubmit) {
      setError(t("server.create.cronjob.required"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const client = createOnePanelClient(server.address, server.key);
      if (isEdit && editId != null) {
        const body: OnePanelCronjobUpdate = { ...buildBody(), id: editId };
        await client.updateCronjob(body);
        showToast(t("server.cronjobs.editSuccess"));
      } else {
        await client.createCronjob(buildBody());
        showToast(t("server.create.cronjob.success"));
      }
      reset();
      onClose();
      onCreated?.();
    } catch (err) {
      setError(formatCreateError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={handleClose}
      title={isEdit ? t("server.cronjobs.editTitle") : t("server.create.cronjob.title")}
      size="xl"
      clipboardAssist={false}
      cancelDisabled={busy}
      closeDisabled={busy}
      primaryAction={{
        label: busy ? t("common.saving") : t("common.confirm"),
        disabled: busy || !canSubmit || optionsLoading,
        onClick: () => void handleSubmit(),
      }}
      status={error ? { kind: "error", message: error } : null}
      bodyClassName="server-create-split"
    >
      <nav className="server-create-split__nav" aria-label={t("server.create.cronjob.type")}>
        {CRONJOB_TYPES.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={type === key}
            className={`server-create-split__nav-item${type === key ? " is-active" : ""}`}
            disabled={busy || isEdit}
            onClick={() => handleTypeChange(key)}
          >
            {t(`server.create.cronjob.types.${key}` as "server.create.cronjob.types.shell")}
          </button>
        ))}
      </nav>

      <div className="server-create-split__main" role="tabpanel">
        <FormField label={t("server.create.cronjob.name")}>
          <TextInput value={name} onChange={setName} disabled={busy} />
        </FormField>

        <FormField label={t("server.create.cronjob.group")}>
          <select
            className="input"
            value={groupId}
            disabled={busy || groups.length === 0}
            onChange={(e) => setGroupId(Number(e.target.value) || 0)}
          >
            {groups.length === 0 ? (
              <option value={0}>{t("server.create.cronjob.groupEmpty")}</option>
            ) : (
              groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name === "Default"
                    ? t("server.create.cronjob.groupDefault")
                    : group.name}
                </option>
              ))
            )}
          </select>
        </FormField>

        <FormField label={t("server.create.cronjob.spec")} hint={t("server.create.cronjob.specHint")}>
          <TextInput value={spec} onChange={setSpec} placeholder="30 1 * * 1" disabled={busy} />
        </FormField>

        {type === "shell" ? (
          <>
            <FormField label={t("server.create.cronjob.executor")}>
              <select
                className="input"
                value={executor}
                disabled={busy}
                onChange={(e) => setExecutor(e.target.value)}
              >
                {EXECUTORS.map((ex) => (
                  <option key={ex} value={ex}>
                    {ex}
                  </option>
                ))}
                {!(EXECUTORS as readonly string[]).includes(executor) && executor ? (
                  <option value={executor}>{executor}</option>
                ) : null}
              </select>
            </FormField>
            <FormField label={t("server.create.cronjob.script")}>
              <CodeEditor
                value={script}
                onChange={setScript}
                language={scriptLanguageForExecutor(executor)}
                readOnly={busy}
                height={300}
                className="server-create-code-editor"
              />
            </FormField>
          </>
        ) : null}

        {type === "curl" ? (
          <FormField label={t("server.create.cronjob.url")} hint={t("server.create.cronjob.urlHint")}>
            <TextInput
              value={url}
              onChange={setUrl}
              placeholder="https://example.com/health"
              disabled={busy}
            />
          </FormField>
        ) : null}

        {type === "clean" ? (
          <p className="form-hint">{t("server.create.cronjob.cleanHint")}</p>
        ) : null}
        {type === "ntp" ? (
          <p className="form-hint">{t("server.create.cronjob.ntpHint")}</p>
        ) : null}

        <FormField label={t("server.create.cronjob.timeout")} hint={t("server.create.cronjob.timeoutHint")}>
          <TextInput
            value={String(timeout)}
            onChange={(v) => setTimeoutSec(Math.max(1, Number(v) || 1))}
            disabled={busy}
          />
        </FormField>
        <FormField
          label={t("server.create.cronjob.retryTimes")}
          hint={t("server.create.cronjob.retryTimesHint")}
        >
          <TextInput
            value={String(retryTimes)}
            onChange={(v) => setRetryTimes(Math.max(0, Number(v) || 0))}
            disabled={busy}
          />
        </FormField>
      </div>
    </FormDialog>
  );
}
