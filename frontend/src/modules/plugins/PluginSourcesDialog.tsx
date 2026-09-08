import { useState } from "react";
import type { RegistrySourceDto, SourceTestResult } from "../../ipc/bindings";
import { FormDialog } from "../../components/ui/form/FormDialog";
import { TextInput } from "../../components/ui/form/TextInput";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { useI18n } from "../../i18n";

type Props = {
  open: boolean;
  sources: RegistrySourceDto[];
  busyId: string | null;
  testResult: SourceTestResult | null;
  onClose: () => void;
  onAdd: (id: string, url: string, keys: string[], token: string | null) => void;
  onRemove: (id: string) => void;
  onSetEnabled: (id: string, enabled: boolean) => void;
  onTest: (id: string) => void;
  onConfirmKey: (id: string, key: string) => void;
};

export function PluginSourcesDialog({
  open,
  sources,
  busyId,
  testResult,
  onClose,
  onAdd,
  onRemove,
  onSetEnabled,
  onTest,
  onConfirmKey,
}: Props) {
  const { t } = useI18n();
  const [id, setId] = useState("");
  const [url, setUrl] = useState("");
  const [keys, setKeys] = useState("");
  const [token, setToken] = useState("");

  const submit = () => {
    const publicKeys = keys
      .split(/[,;\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    onAdd(id.trim(), url.trim(), publicKeys, token.trim() || null);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("plugins.sources.title")}
      size="lg"
      cancelLabel={t("common.close")}
    >
      <p className="text-xs text-muted mb-3">{t("plugins.sources.hint")}</p>
      <ul className="space-y-3 mb-4">
        {sources.map((source) => (
          <li key={source.id} className="border border-border rounded p-2 space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs">{source.id}</span>
              {source.builtin ? (
                <span className="plugin-center-badge plugin-center-badge--official">
                  {t("plugins.sources.builtin")}
                </span>
              ) : null}
              {!source.enabled ? (
                <span className="text-xs text-muted">{t("settings.plugins.disabled")}</span>
              ) : null}
            </div>
            <p className="text-xs text-muted break-all">{source.url}</p>
            {source.keyPending ? (
              <p className="text-xs text-danger">{t("plugins.sources.keyPending")}</p>
            ) : null}
            <div className="flex flex-wrap gap-1">
              <WorkbenchActionButton
                disabled={busyId === source.id}
                onClick={() => onSetEnabled(source.id, !source.enabled)}
              >
                {source.enabled ? t("plugins.sources.disable") : t("plugins.sources.enable")}
              </WorkbenchActionButton>
              <WorkbenchActionButton disabled={busyId === source.id} onClick={() => onTest(source.id)}>
                {t("plugins.sources.test")}
              </WorkbenchActionButton>
              {source.keyPending ? (
                <WorkbenchActionButton
                  disabled={busyId === source.id}
                  onClick={() => onConfirmKey(source.id, source.keyPending ?? "")}
                >
                  {t("plugins.sources.confirmKey")}
                </WorkbenchActionButton>
              ) : null}
              {!source.builtin ? (
                <WorkbenchActionButton
                  danger
                  disabled={busyId === source.id}
                  onClick={() => onRemove(source.id)}
                >
                  {t("plugins.sources.delete")}
                </WorkbenchActionButton>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {testResult ? (
        <p className={`text-xs mb-3 ${testResult.ok ? "text-muted" : "text-danger"}`}>
          {testResult.ok
            ? t("plugins.sources.testOk", { count: String(testResult.pluginCount) })
            : (testResult.error ?? t("plugins.sources.testFail"))}
        </p>
      ) : null}
      <div className="space-y-2">
        <TextInput value={id} onChange={setId} placeholder={t("plugins.sources.id")} copyable={false} />
        <TextInput value={url} onChange={setUrl} placeholder={t("plugins.sources.url")} copyable={false} />
        <TextInput value={keys} onChange={setKeys} placeholder={t("plugins.sources.keys")} copyable={false} />
        <TextInput value={token} onChange={setToken} placeholder={t("plugins.sources.token")} copyable={false} />
        <WorkbenchActionButton disabled={!id.trim() || !url.trim() || busyId === "__add__"} onClick={submit}>
          {t("plugins.sources.add")}
        </WorkbenchActionButton>
      </div>
    </FormDialog>
  );
}
