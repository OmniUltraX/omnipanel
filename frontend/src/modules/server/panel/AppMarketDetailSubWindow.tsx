import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../i18n";
import { SubWindow } from "../../../components/ui/window/SubWindow";
import { WorkbenchActionButton } from "../../../components/ui/primitives/WorkbenchActionButton";
import { createOnePanelClient, type OnePanelApp } from "../../../lib/onepanel";
import { stripHtmlToPlainText } from "../../../lib/stripHtmlToPlainText";
import { isOnePanelService } from "./panelPlugin";
import type { ServerEntry } from "./serverConnection";
import type { AppInstallDisplayState } from "./serverAppInstallStatus";

export type AppMarketDetailApp = OnePanelApp & {
  installState: AppInstallDisplayState;
  installId?: number;
  installMessage?: string;
  installVersion?: string;
  httpPort?: number;
};

export type AppMarketDetailSubWindowProps = {
  open: boolean;
  onClose: () => void;
  server: ServerEntry;
  app: AppMarketDetailApp | null;
  iconSrc?: string | null;
  canInstall?: boolean;
  canUninstall?: boolean;
  canOpenParams?: boolean;
  canManageInDatabase?: boolean;
  canViewInstallLog?: boolean;
  busy?: boolean;
  managing?: boolean;
  onInstall?: () => void;
  onUninstall?: () => void;
  onOpenParams?: () => void;
  onManageInDatabase?: () => void;
  onViewInstallLog?: () => void;
};

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function appDescription(app: OnePanelApp, locale: string): string {
  if (locale.startsWith("zh")) {
    return stripHtmlToPlainText(
      app.shortDescZh || app.description || app.shortDescEn || "",
    );
  }
  return stripHtmlToPlainText(
    app.shortDescEn || app.description || app.shortDescZh || "",
  );
}

function statusLabel(
  state: AppInstallDisplayState,
  t: (key: string) => string,
): string {
  if (state === "installing") return t("server.appMarket.installing");
  if (state === "failed") return t("server.appMarket.installFailed");
  if (state === "installed") return t("server.appMarket.installed");
  return t("server.appMarket.available");
}

export function AppMarketDetailSubWindow({
  open,
  onClose,
  server,
  app,
  iconSrc,
  canInstall = false,
  canUninstall = false,
  canOpenParams = false,
  canManageInDatabase = false,
  canViewInstallLog = false,
  busy = false,
  managing = false,
  onInstall,
  onUninstall,
  onOpenParams,
  onManageInDatabase,
  onViewInstallLog,
}: AppMarketDetailSubWindowProps) {
  const { t, locale } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enriched, setEnriched] = useState<OnePanelApp | null>(null);

  useEffect(() => {
    if (!open || !app) {
      setEnriched(null);
      setError(null);
      setLoading(false);
      return;
    }
    // 1Panel：打开时补拉 /apps/:key，拿更完整的 versions / 描述；宝塔沿用列表数据
    if (!isOnePanelService(server.serviceType)) {
      setEnriched(null);
      setError(null);
      setLoading(false);
      return;
    }
    const key = (app.key || "").trim();
    if (!key) {
      setEnriched(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const detail = await createOnePanelClient(
          server.address,
          server.key,
          server.id,
          server.panelUser,
        ).getApp(key);
        if (!cancelled) setEnriched(detail);
      } catch (err) {
        // 列表数据仍可展示；补拉失败只提示，不挡详情
        if (!cancelled) setError(formatError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app, open, server.address, server.id, server.key, server.serviceType]);

  const display = useMemo(() => {
    if (!app) return null;
    if (!enriched) return app;
    return {
      ...app,
      ...enriched,
      // 安装态以市场卡为准
      installState: app.installState,
      installId: app.installId,
      installMessage: app.installMessage,
      installVersion: app.installVersion || pickFirstVersion(enriched.versions),
      httpPort: app.httpPort,
      versions: enriched.versions?.length ? enriched.versions : app.versions,
    } satisfies AppMarketDetailApp;
  }, [app, enriched]);

  const desc = display ? appDescription(display, locale) : "";
  const title = display
    ? t("server.appMarket.detailTitle", { name: display.name || display.key || "—" })
    : t("server.appMarket.detail");

  const rows = useMemo(() => {
    if (!display) return [];
    const out: Array<{ id: string; label: string; value: string }> = [];
    const push = (id: string, label: string, value: string | undefined | null) => {
      const v = (value ?? "").trim();
      if (!v) return;
      out.push({ id, label, value: v });
    };
    push("key", t("server.appMarket.fields.key"), display.key);
    push("type", t("server.appMarket.fields.type"), display.type);
    push(
      "status",
      t("server.appMarket.fields.status"),
      statusLabel(display.installState, t),
    );
    push(
      "versions",
      t("server.appMarket.fields.versions"),
      (display.versions ?? []).join(", "),
    );
    push(
      "installVersion",
      t("server.appMarket.fields.installVersion"),
      display.installVersion,
    );
    if (display.httpPort != null && display.httpPort > 0) {
      push("httpPort", t("server.appMarket.fields.httpPort"), String(display.httpPort));
    }
    push("resource", t("server.appMarket.fields.resource"), display.resource);
    const tags = (display.tags ?? [])
      .map((tag) => (tag.name || tag.key || "").trim())
      .filter(Boolean)
      .join(", ");
    push("tags", t("server.appMarket.fields.tags"), tags);
    push("message", t("server.appMarket.fields.message"), display.installMessage);
    return out;
  }, [display, t]);

  const showInstall = canInstall && display?.installState === "available";
  const showUninstall = canUninstall && display?.installState === "installed";
  const showParams = canOpenParams && display?.installState === "installed";
  const showManage = canManageInDatabase && display?.installState === "installed";
  const showLog =
    canViewInstallLog &&
    (display?.installState === "installing" || display?.installState === "failed");
  const hasActions = showInstall || showUninstall || showParams || showManage || showLog;

  return (
    <SubWindow
      open={open && display != null}
      title={title}
      onClose={onClose}
      widthRatio={0.52}
      heightRatio={0.72}
      className="server-app-detail-subwindow"
    >
      {!display ? null : (
        <div className="server-app-detail">
          <div className="server-app-detail__hero">
            {iconSrc ? (
              <img className="server-app-detail__icon" src={iconSrc} alt="" draggable={false} />
            ) : (
              <div className="server-app-detail__icon server-app-detail__icon--placeholder">
                {(display.name || display.key || "?").slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="server-app-detail__titles">
              <div className="server-app-detail__name">{display.name || display.key || "—"}</div>
              {display.type ? (
                <div className="server-app-detail__type">{display.type}</div>
              ) : null}
              <span
                className={`server-app-card__status server-app-card__status--${
                  display.installState === "installed"
                    ? "success"
                    : display.installState === "failed"
                      ? "danger"
                      : display.installState === "installing"
                        ? "warning"
                        : "muted"
                }`}
              >
                {statusLabel(display.installState, t)}
              </span>
            </div>
          </div>

          {loading ? (
            <div className="server-apps-empty">{t("server.appMarket.detailLoading")}</div>
          ) : null}
          {error ? (
            <div className="server-apps-hint">
              {t("server.appMarket.detailEnrichFailed", { detail: error })}
            </div>
          ) : null}

          <div className="drawer-section server-website-detail">
            <dl className="drawer-kv">
              {rows.map((row) => (
                <div key={row.id} style={{ display: "contents" }}>
                  <dt>{row.label}</dt>
                  <dd>
                    <pre className="server-website-detail__value">{row.value}</pre>
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {desc ? (
            <section className="server-app-detail__desc">
              <h3 className="server-app-detail__desc-title">
                {t("server.appMarket.fields.description")}
              </h3>
              <p className="server-app-detail__desc-body">{desc}</p>
            </section>
          ) : null}

          {hasActions ? (
            <div className="server-app-detail__footer">
              {showInstall ? (
                <WorkbenchActionButton disabled={busy} onClick={onInstall}>
                  {busy ? t("server.appMarket.installing") : t("server.appMarket.install")}
                </WorkbenchActionButton>
              ) : null}
              {showUninstall ? (
                <WorkbenchActionButton danger disabled={busy} onClick={onUninstall}>
                  {t("server.appMarket.uninstall")}
                </WorkbenchActionButton>
              ) : null}
              {showLog ? (
                <WorkbenchActionButton onClick={onViewInstallLog}>
                  {t("server.appMarket.viewInstallLog")}
                </WorkbenchActionButton>
              ) : null}
              {showParams ? (
                <WorkbenchActionButton onClick={onOpenParams}>
                  {t("server.appMarket.paramsOpenHint")}
                </WorkbenchActionButton>
              ) : null}
              {showManage ? (
                <WorkbenchActionButton disabled={managing} onClick={onManageInDatabase}>
                  {managing
                    ? t("server.appMarket.managingInDatabase")
                    : t("server.appMarket.manageInDatabase")}
                </WorkbenchActionButton>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </SubWindow>
  );
}

function pickFirstVersion(versions: string[] | undefined): string | undefined {
  if (!versions || versions.length === 0) return undefined;
  const first = versions[0]?.trim();
  return first || undefined;
}
