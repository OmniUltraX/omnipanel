import { useEffect, useMemo, useState } from "react";
import { FormDialog } from "../../../components/ui/form/FormDialog";
import { CheckIcon, CopyIcon, useCopyFeedback } from "../../../components/ui/form/inputFieldShared";
import { Button } from "../../../components/ui/primitives/Button";
import { useI18n } from "../../../i18n";
import type { OnePanelAppInstalledParams, OnePanelAppParam } from "../../../lib/onepanel";
import { getPanelDriver, panelConnectionCtx } from "../../../lib/panelDriverRegistry";
import { quickInput } from "../../../lib/quickInput";
import { showToast } from "../../../stores/toastStore";
import {
  defaultPanelAppConnectionName,
  importPanelAppToDatabase,
  isPanelAppManagedByDatabase,
} from "./importPanelAppToDatabase";
import type { ServerEntry } from "./serverConnection";

export type AppInstalledParamsDialogProps = {
  open: boolean;
  onClose: () => void;
  server: ServerEntry;
  installId: number | null;
  appLabel: string;
  appKey?: string;
  appType?: string;
};

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function paramLabel(param: OnePanelAppParam, locale: string): string {
  if (locale.startsWith("zh")) {
    return param.labelZh || param.labelEn || param.key;
  }
  return param.labelEn || param.labelZh || param.key;
}

function isSensitiveParam(param: OnePanelAppParam): boolean {
  const type = (param.type || "").toLowerCase();
  const key = param.key.toLowerCase();
  return (
    type.includes("password") ||
    type.includes("secret") ||
    /password|passwd|secret|token|apikey|api_key/.test(key)
  );
}

function formatParamValue(param: OnePanelAppParam, yesLabel: string, noLabel: string): string {
  if (param.showValue && param.showValue.trim()) {
    return param.showValue;
  }
  const value = param.value;
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? yesLabel : noLabel;
  if (typeof value === "string" || typeof value === "number") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ParamRow({
  label,
  value,
  secret,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);
  const { copied, copy } = useCopyFeedback();
  const empty = value === "—";
  const display = secret && !revealed ? "••••••••" : value;
  return (
    <div className="app-installed-params__row">
      <span className="app-installed-params__label" title={label}>
        {label}
      </span>
      <span className="app-installed-params__value" title={secret && !revealed ? undefined : value}>
        {display}
      </span>
      <div className="app-installed-params__actions">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={empty}
          title={copied ? t("common.copied") : t("common.copy")}
          aria-label={copied ? t("common.copied") : t("common.copy")}
          onClick={() => {
            if (!empty) void copy(value);
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
        {secret && !empty ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRevealed((prev) => !prev)}
          >
            {revealed ? t("common.hideSecret") : t("common.showSecret")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function AppInstalledParamsDialog({
  open,
  onClose,
  server,
  installId,
  appLabel,
  appKey,
  appType,
}: AppInstalledParamsDialogProps) {
  const { t, locale } = useI18n();
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<OnePanelAppInstalledParams | null>(null);
  const canManage = isPanelAppManagedByDatabase({ key: appKey, name: appLabel, type: appType });

  useEffect(() => {
    if (!open || installId == null) {
      return;
    }
    const driver = getPanelDriver(server.serviceType);
    if (!driver?.getInstalledAppParams) {
      setConfig(null);
      setError(t("server.appMarket.unsupported"));
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setConfig(null);
    setImporting(false);
    void driver
      .getInstalledAppParams(panelConnectionCtx(server), { id: installId })
      .then((data) => {
        if (!cancelled) setConfig(data as OnePanelAppInstalledParams);
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [installId, open, server, t]);

  const metaRows = useMemo(() => {
    if (!config) return [];
    const rows: { label: string; value: string }[] = [];
    if (config.containerName) {
      rows.push({ label: t("server.appMarket.paramsContainer"), value: config.containerName });
    }
    if (config.webUI) {
      rows.push({ label: t("server.appMarket.paramsWebUI"), value: config.webUI });
    }
    if (config.specifyIP) {
      rows.push({ label: t("server.appMarket.paramsSpecifyIP"), value: config.specifyIP });
    }
    if (config.cpuQuota != null && config.cpuQuota > 0) {
      rows.push({ label: t("server.appMarket.paramsCpuQuota"), value: String(config.cpuQuota) });
    }
    if (config.memoryLimit != null && config.memoryLimit > 0) {
      rows.push({
        label: t("server.appMarket.paramsMemoryLimit"),
        value: `${config.memoryLimit}${config.memoryUnit ? ` ${config.memoryUnit}` : ""}`,
      });
    }
    if (config.restartPolicy) {
      rows.push({ label: t("server.appMarket.paramsRestartPolicy"), value: config.restartPolicy });
    }
    if (config.hostMode != null) {
      rows.push({
        label: t("server.appMarket.paramsHostMode"),
        value: config.hostMode ? t("server.appMarket.paramsYes") : t("server.appMarket.paramsNo"),
      });
    }
    if (config.allowPort != null) {
      rows.push({
        label: t("server.appMarket.paramsAllowPort"),
        value: config.allowPort ? t("server.appMarket.paramsYes") : t("server.appMarket.paramsNo"),
      });
    }
    return rows;
  }, [config, t]);

  const handleImportToDatabase = async () => {
    if (!config || importing) return;
    const name = await quickInput({
      title: t("server.appMarket.manageInDatabaseNameTitle"),
      placeholder: t("server.appMarket.manageInDatabaseNamePlaceholder"),
      defaultValue: defaultPanelAppConnectionName(server.name, appLabel),
      validate: (value) =>
        value.trim() ? null : t("server.appMarket.manageInDatabaseNameRequired"),
    });
    if (!name) return;
    setImporting(true);
    try {
      const result = await importPanelAppToDatabase({
        server,
        appLabel,
        appKey,
        appType,
        config,
        name: name.trim(),
      });
      showToast(
        result.created
          ? t("server.appMarket.manageInDatabaseDone", { name: result.connection.name })
          : t("server.appMarket.manageInDatabaseExists", { name: result.connection.name }),
      );
      onClose();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("server.appMarket.paramsTitle", { name: appLabel })}
      subtitle={t("server.appMarket.paramsSubtitle")}
      size="md"
      cancelLabel={t("common.close")}
      onCancel={onClose}
      status={error ? { kind: "error", message: error } : null}
      primaryAction={
        canManage && config && !loading
          ? {
              label: importing
                ? t("server.appMarket.managingInDatabase")
                : t("server.appMarket.manageInDatabase"),
              disabled: importing,
              onClick: () => void handleImportToDatabase(),
            }
          : undefined
      }
    >
      <div className="app-installed-params">
        {loading ? (
          <p className="app-installed-params__hint">{t("server.appMarket.paramsLoading")}</p>
        ) : null}
        {!loading && !error && config && config.params.length === 0 && metaRows.length === 0 ? (
          <p className="app-installed-params__hint">{t("server.appMarket.paramsEmpty")}</p>
        ) : null}
        {!loading && config ? (
          <>
            {metaRows.length > 0 ? (
              <div className="app-installed-params__section">
                {metaRows.map((row) => (
                  <ParamRow key={row.label} label={row.label} value={row.value} />
                ))}
              </div>
            ) : null}
            {config.params.length > 0 ? (
              <div className="app-installed-params__section">
                {config.params.map((param) => (
                  <ParamRow
                    key={param.key}
                    label={paramLabel(param, locale)}
                    value={formatParamValue(
                      param,
                      t("server.appMarket.paramsYes"),
                      t("server.appMarket.paramsNo"),
                    )}
                    secret={isSensitiveParam(param)}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </FormDialog>
  );
}
