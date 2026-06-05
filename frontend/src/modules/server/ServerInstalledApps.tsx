import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import type { ServerEntry } from "./CreateServerDialog";
import {
  getAppDescription,
  getAppDisplayName,
  getAppInstanceName,
  getAppPortTags,
  getAppStatus,
  getAppStatusClass,
} from "./appCard";
import { useAppIcon } from "./useAppIcon";
import { ServerAppDrawer } from "./ServerAppDrawer";
import type { ServerInstalledApp } from "./serverApp";
import { useInstalledApps } from "./useInstalledApps";

interface ServerInstalledAppsProps {
  server: ServerEntry;
}

function ServerAppCard({
  server,
  app,
  t,
  onSelect,
}: {
  server: ServerEntry;
  app: ServerInstalledApp;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onSelect: (app: ServerInstalledApp) => void;
}) {
  const { iconUrl, loading } = useAppIcon(server, app);
  const [iconFailed, setIconFailed] = useState(false);
  const displayName = getAppDisplayName(app);
  const instanceName = getAppInstanceName(app);
  const status = getAppStatus(app);
  const portTags = getAppPortTags(app);
  const description = getAppDescription(app);
  const showIcon = iconUrl && !iconFailed && !loading;

  useEffect(() => {
    setIconFailed(false);
  }, [iconUrl]);

  return (
    <article
      className="server-app-card server-app-card--clickable"
      role="button"
      tabIndex={0}
      onClick={() => onSelect(app)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(app);
        }
      }}
    >
      <div className="server-app-card__top">
        <div className="server-app-card__head">
          {showIcon ? (
            <img
              className="server-app-card__icon"
              src={iconUrl}
              alt=""
              loading="lazy"
              onError={() => setIconFailed(true)}
            />
          ) : (
            <span
              className={`server-app-card__icon server-app-card__icon--placeholder${loading ? " server-app-card__icon--loading" : ""}`}
            >
              {(displayName[0] ?? "?").toUpperCase()}
            </span>
          )}
          <div className="server-app-card__titles">
            <strong className="server-app-card__name" title={displayName}>
              {displayName}
            </strong>
            {instanceName ? (
              <span className="server-app-card__instance" title={instanceName}>
                {instanceName}
              </span>
            ) : null}
          </div>
        </div>
        <span className={`server-app-card__status server-app-card__status--${getAppStatusClass(status)}`}>
          <span
            className={`status-dot ${status === "Running" || status.toLowerCase() === "running" ? "online" : "offline"}`}
          />
          {status}
        </span>
      </div>

      {(portTags.length > 0 || app.canUpdate || app.appType) && (
        <div className="server-app-card__tags">
          {app.appType ? (
            <span className="badge badge-muted server-app-card__tag">{app.appType}</span>
          ) : null}
          {portTags.map((tag) => (
            <span key={tag} className="badge badge-muted server-app-card__tag">
              {tag}
            </span>
          ))}
          {app.canUpdate ? (
            <span className="badge badge-accent server-app-card__tag">{t("server.apps.updateAvailable")}</span>
          ) : null}
        </div>
      )}

      {description ? (
        <p className="server-app-card__message" title={description}>
          {description}
        </p>
      ) : null}
    </article>
  );
}

export function ServerInstalledApps({ server }: ServerInstalledAppsProps) {
  const { t } = useI18n();
  const { apps, total, loading, error, refresh } = useInstalledApps(server);
  const [selectedApp, setSelectedApp] = useState<ServerInstalledApp | null>(null);

  if (server.serviceType !== "1panel" && server.serviceType !== "bt") {
    return (
      <div className="server-apps">
        <div className="server-apps-empty">{t("server.apps.unsupported")}</div>
      </div>
    );
  }

  return (
    <>
      <div className="server-apps">
        <div className="server-header">
          <div>
            <strong>{server.name}</strong>
            <span>{server.address}</span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? t("server.apps.loading") : t("server.refresh")}
          </button>
        </div>

        <div className="server-apps-toolbar">
          <span className="server-apps-title">{t("server.apps.title")}</span>
          <span className="badge badge-muted">{total}</span>
        </div>

        {error && <div className="server-apps-error">{error}</div>}

        <div className="server-apps-body">
          {loading && apps.length === 0 ? (
            <div className="server-apps-empty">{t("server.apps.loading")}</div>
          ) : apps.length === 0 ? (
            <div className="server-apps-empty">{t("server.apps.empty")}</div>
          ) : (
            <div className="server-app-grid">
              {apps.map((app) => (
                <ServerAppCard
                  key={app.uid}
                  server={server}
                  app={app}
                  t={t}
                  onSelect={setSelectedApp}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <ServerAppDrawer server={server} app={selectedApp} onClose={() => setSelectedApp(null)} />
    </>
  );
}
