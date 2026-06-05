import { useEffect, useState } from "react";
import { LogViewer } from "../../components/ui/LogViewer";
import { SubWindow } from "../../components/ui/SubWindow";
import { useI18n } from "../../i18n";
import type { ServerEntry } from "./CreateServerDialog";
import { formatAppPorts } from "./appCard";
import { formatBtAppInfoValue } from "./serverApp";
import type { ServerInstalledApp } from "./serverApp";
import { useAppComposeLogs } from "./useAppComposeLogs";

type AppTab = "detail" | "logs";

interface ServerAppDrawerProps {
  server: ServerEntry;
  app: ServerInstalledApp | null;
  onClose: () => void;
}

function DetailTab({
  server,
  app,
  t,
}: {
  server: ServerEntry;
  app: ServerInstalledApp;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const displayName = app.appName || app.name || app.appKey || "-";
  const status = app.status || app.appStatus || "-";

  const rows: Array<{ label: string; value: string }> = [
    { label: t("server.apps.drawer.appName"), value: displayName },
    { label: t("server.apps.drawer.instance"), value: app.serviceName || app.name || "-" },
    { label: t("server.apps.drawer.appKey"), value: app.appKey || "-" },
    { label: t("server.apps.version"), value: app.version || "-" },
    { label: t("server.apps.status"), value: status },
    { label: t("server.apps.type"), value: app.appType || "-" },
    { label: t("server.apps.port"), value: formatAppPorts(app) },
    { label: t("server.apps.drawer.container"), value: app.container || "-" },
    { label: t("server.apps.drawer.path"), value: app.path || "-" },
    { label: t("server.apps.drawer.createdAt"), value: app.runtimeLabel || app.createdAt || "-" },
  ];

  if (app.serverIp) {
    rows.push({ label: t("server.apps.drawer.serverIp"), value: app.serverIp });
  }
  if (app.app?.website) {
    rows.push({ label: t("server.apps.drawer.website"), value: app.app.website });
  }
  if (app.description) {
    rows.push({ label: t("server.apps.drawer.description"), value: app.description });
  }
  if (app.message && app.message !== app.description) {
    rows.push({ label: t("server.apps.drawer.message"), value: app.message });
  }

  const configRows =
    server.serviceType === "bt" && app.btAppInfo?.length
      ? app.btAppInfo.map((field) => ({
          label: field.fieldTitle,
          value: formatBtAppInfoValue(field.fieldValue),
        }))
      : [];

  return (
    <>
      <div className="drawer-section">
        <h4>{t("server.apps.drawer.basicInfo")}</h4>
        <dl className="drawer-kv">
          {rows.map((row) => (
            <div key={row.label} style={{ display: "contents" }}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {configRows.length > 0 ? (
        <div className="drawer-section">
          <h4>{t("server.apps.drawer.config")}</h4>
          <dl className="drawer-kv">
            {configRows.map((row) => (
              <div key={`${row.label}-${row.value}`} style={{ display: "contents" }}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </>
  );
}

function LogsTab({
  server,
  app,
  t,
}: {
  server: ServerEntry;
  app: ServerInstalledApp;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const { logs, loading, error, refresh, clear } = useAppComposeLogs(server, app, true);

  return (
    <LogViewer
      className="server-app-subwindow__logs"
      text={logs}
      loading={loading}
      loadingText={t("server.apps.drawer.logsLoading")}
      emptyText={t("server.apps.drawer.logsEmpty")}
      error={error}
      onClear={clear}
      toolbar={
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? t("server.apps.loading") : t("server.refresh")}
        </button>
      }
    />
  );
}

function ServerAppSubWindowContent({
  server,
  app,
}: {
  server: ServerEntry;
  app: ServerInstalledApp;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<AppTab>("detail");

  useEffect(() => {
    setTab("detail");
  }, [app.uid]);

  return (
    <div className="server-app-subwindow">
      <div className="server-app-subwindow__tabs">
        <button
          type="button"
          className={`subtab${tab === "detail" ? " active" : ""}`}
          onClick={() => setTab("detail")}
        >
          {t("server.apps.drawer.detail")}
        </button>
        {server.serviceType === "1panel" ? (
          <button
            type="button"
            className={`subtab${tab === "logs" ? " active" : ""}`}
            onClick={() => setTab("logs")}
          >
            {t("server.apps.drawer.logs")}
          </button>
        ) : null}
      </div>
      <div className={`server-app-subwindow__body${tab === "logs" ? " server-app-subwindow__body--logs" : ""}`}>
        {tab === "detail" && (
          <div className="server-app-subwindow__detail">
            <DetailTab server={server} app={app} t={t} />
          </div>
        )}
        {tab === "logs" && server.serviceType === "1panel" ? (
          <LogsTab server={server} app={app} t={t} />
        ) : null}
      </div>
    </div>
  );
}

export function ServerAppDrawer({ server, app, onClose }: ServerAppDrawerProps) {
  const displayName = app?.appName || app?.name || app?.appKey || "";

  return (
    <SubWindow
      open={Boolean(app)}
      title={displayName}
      onClose={onClose}
      className="server-app-subwindow-panel"
      widthRatio={0.82}
      heightRatio={0.8}
    >
      {app ? <ServerAppSubWindowContent server={server} app={app} /> : null}
    </SubWindow>
  );
}
