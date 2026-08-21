import { useCallback, useMemo, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import { useI18n } from "@/i18n";
import { type Connection, type PanelProbeItem } from "@/ipc/bindings";
import { showToast } from "@/stores/toastStore";
import { IconLink } from "@/components/ui/icons/Icons";
import { parseSshConfig } from "../../../panel/serverConnection";
import { panelProbeReachableAddress, panelProbeBrowserUrl } from "../../../panel/panelAddress";
import { ServerConnectionDialog } from "../../../panel/ServerConnectionDialog";
import type { PanelFormData } from "../../../panel/panelForm";
import { PLUGIN_ID_PANEL_1PANEL, PLUGIN_ID_PANEL_BT } from "../../../panel/panelPlugin";
import { usePanelProbe } from "../../hooks/usePanelProbe";
import { BrandIconImg } from "../../../brandIcons";

type Props = {
  resourceId: string;
  /** 关联的 SSH 连接（用于取 host 替换 127.0.0.1、判断是否已关联 panel） */
  connection: Connection | null;
  /** 嵌入运维分组时不渲染独立 section 标题 */
  embedded?: boolean;
};

const PANEL_KINDS = ["bt", "1panel"] as const;

function emptyPanel(kind: string): PanelProbeItem {
  return {
    kind,
    installed: false,
    address: "",
    port: 0,
    entrance: "",
    apiEnabled: false,
    apiKey: "",
    note: "",
  };
}

function panelVersionNote(note: string): { version: string | null; desc: string | null } {
  const n = note.trim();
  if (!n) return { version: null, desc: null };
  if (/^v?\d+(\.\d+)*/.test(n)) return { version: n, desc: null };
  return { version: null, desc: n };
}

/**
 * 面板检测区块：嵌入「运维能力」分组，与 Docker / Nginx 卡片同一行。
 *
 * 自动探测 SSH 主机上已安装的宝塔 / 1Panel：
 * - 已安装 → 右上角「就绪」、左下角「已安装」，标题旁可打开安全入口
 * - 未安装 → 右上角「待安装」，不展示入口链接
 *
 * 不再在卡片上展示 API Key；「一键管理」打开服务器面板表单并预填安全入口与 API Key。
 */
export function PanelProbeSection({ resourceId, connection, embedded = false }: Props) {
  const { t } = useI18n();
  const { result, loading, error, refresh } = usePanelProbe(resourceId);
  const [manageDraft, setManageDraft] = useState<{
    form: Partial<PanelFormData>;
    sshId: string;
  } | null>(null);

  // 从 SSH connection 提取真实 host，替换探测结果里的 127.0.0.1
  const sshHost = useMemo(() => {
    if (!connection) return null;
    const cfg = parseSshConfig(connection);
    return (cfg?.publicIp || cfg?.host || "").trim() || null;
  }, [connection]);

  // 把探测结果里的 127.0.0.1 替换为真实 host；API 地址不含安全入口
  const realAddress = useCallback(
    (panel: PanelProbeItem): string => {
      return panelProbeReachableAddress(panel, connection);
    },
    [connection],
  );

  const browserUrl = useCallback(
    (panel: PanelProbeItem): string => {
      return panelProbeBrowserUrl(panel, connection);
    },
    [connection],
  );

  const handleOpenEntrance = useCallback(
    async (url: string) => {
      if (!url) return;
      try {
        await openExternal(url);
      } catch (e) {
        console.warn("[panelProbe] open entrance failed", e);
        try {
          window.open(url, "_blank", "noopener,noreferrer");
        } catch {
          showToast(t("ssh.panelProbe.openEntranceFailed"));
        }
      }
    },
    [t],
  );

  const handleQuickManage = useCallback(
    (panel: PanelProbeItem) => {
      if (!connection) return;
      const serviceType = panel.kind === "bt" ? PLUGIN_ID_PANEL_BT : PLUGIN_ID_PANEL_1PANEL;
      const typeLabel = panel.kind === "bt" ? "宝塔" : "1Panel";
      const hostLabel = connection.name?.trim() || sshHost || "host";
      setManageDraft({
        sshId: connection.id,
        form: {
          name: `${hostLabel} · ${typeLabel}`,
          panelAddress: realAddress(panel),
          panelKey: panel.apiKey?.trim() || "",
          serviceType,
        },
      });
    },
    [connection, realAddress, sshHost],
  );

  const installedCount = useMemo(() => {
    if (!result) return 0;
    const panels = Array.isArray(result.panels) ? result.panels : [];
    return panels.filter((p) => p?.installed).length;
  }, [result]);

  const cards = result
    ? PANEL_KINDS.map((kind) => {
        const found = (Array.isArray(result.panels) ? result.panels : []).find(
          (p) => p?.kind === kind,
        );
        const panel = found ?? emptyPanel(kind);
        const addr = panel.installed ? realAddress(panel) : "";
        const entranceUrl = panel.installed ? browserUrl(panel) : "";
        const { version, desc } = panelVersionNote(panel.note ?? "");
        return (
          <article
            key={kind}
            className={`capabilities__card${
              panel.installed ? " capabilities__card--ready" : " capabilities__card--warn"
            }`}
          >
            <div className="capabilities__card-top">
              <div className="capabilities__card-title">
                <span className="capabilities__card-name">
                  <BrandIconImg
                    kind={kind === "bt" ? "bt" : "1panel"}
                    size={16}
                    className="capabilities__card-icon"
                  />
                  {kind === "bt" ? "宝塔面板" : "1Panel"}
                  {entranceUrl ? (
                    <button
                      type="button"
                      className="capabilities__card-link"
                      onClick={() => void handleOpenEntrance(entranceUrl)}
                      title={t("ssh.panelProbe.openEntrance")}
                      aria-label={t("ssh.panelProbe.openEntrance")}
                    >
                      <IconLink size={14} />
                    </button>
                  ) : null}
                </span>
                <span className="capabilities__card-id">{kind}</span>
              </div>
              <span
                className={
                  panel.installed ? "cap-badge cap-badge--ok" : "cap-badge cap-badge--warn"
                }
              >
                {panel.installed
                  ? t("ssh.toolCapabilities.states.ready")
                  : t("ssh.toolCapabilities.states.needInstall")}
              </span>
            </div>
            <div className="capabilities__card-body">
              {panel.installed ? (
                <>
                  <div className="capabilities__card-version">
                    {version ? (
                      <>
                        <span className="capabilities__card-version-label">
                          {t("ssh.toolCapabilities.versionLabel")}
                        </span>
                        <span className="capabilities__card-version-value">{version}</span>
                      </>
                    ) : (
                      <span className="capabilities__card-version-value capabilities__card-version-value--muted">
                        {t("ssh.toolCapabilities.states.readyNoVersion")}
                      </span>
                    )}
                  </div>
                  {addr ? (
                    <div className="capabilities__card-path" title={addr}>
                      {addr}
                    </div>
                  ) : null}
                  {desc ? <p className="capabilities__card-desc">{desc}</p> : null}
                </>
              ) : (
                <p className="capabilities__card-desc">
                  {t("ssh.panelProbe.notInstalledDesc")}
                </p>
              )}
            </div>
            <div className="capabilities__card-actions">
              {panel.installed ? (
                <span className="capabilities__card-installed">
                  {t("ssh.toolCapabilities.installed")}
                </span>
              ) : null}
              {panel.installed && connection ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => handleQuickManage(panel)}
                  title={t("ssh.panelProbe.quickManageHint")}
                >
                  {t("ssh.toolCapabilities.quickManage")}
                </button>
              ) : null}
            </div>
          </article>
        );
      })
    : [];

  const dialog = (
    <ServerConnectionDialog
      open={manageDraft != null}
      onClose={() => setManageDraft(null)}
      onSaved={() => {
        setManageDraft(null);
        refresh();
      }}
      initialForm={manageDraft?.form}
      bindSshConnectionId={manageDraft?.sshId}
    />
  );

  if (embedded) {
    return (
      <>
        {cards}
        {dialog}
      </>
    );
  }

  const panelCards = (
    <>
      {loading && !result ? (
        <div className="capabilities__empty">{t("common.loading")}</div>
      ) : null}

      {error ? <div className="capabilities__error">{error}</div> : null}

      <div className="capabilities__list">{cards}</div>
    </>
  );

  return (
    <section className="capabilities__group capabilities__group--panel">
      <h4 className="capabilities__group-title">
        {t("ssh.panelProbe.title")}
        <span className="capabilities__group-count">{installedCount}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => refresh()}
          disabled={loading}
          style={{ marginLeft: "auto" }}
        >
          {loading ? t("common.loading") : t("common.refresh")}
        </button>
      </h4>
      {panelCards}
      {dialog}
    </section>
  );
}
