import { useCallback, useMemo, useState } from "react";

import { appConfirm } from "@/lib/appConfirm";
import { useI18n } from "@/i18n";
import { commands, type Connection, type PanelProbeItem } from "@/ipc/bindings";
import { formatIpcError, unwrapCommand } from "@/ipc/result";
import { showToast } from "@/stores/toastStore";
import { useConnectionStore } from "@/stores/connectionStore";
import {
  buildPanelConnection,
  findPanelForSsh,
  parseSshConfig,
} from "../../../panel/serverConnection";
import { usePanelProbe } from "../../hooks/usePanelProbe";
import { BrandIconImg } from "../../../brandIcons";

type Props = {
  resourceId: string;
  /** 关联的 SSH 连接（用于取 host 替换 127.0.0.1、判断是否已关联 panel） */
  connection: Connection | null;
};

/**
 * 面板检测区块：嵌入「能力」Tab 底部。
 *
 * 自动探测 SSH 主机上已安装的宝塔 / 1Panel 面板：
 * - 已安装且 API 已开启且能读到 key → 一键添加（全自动）
 * - 已安装但 API 未开启 → 可一键开启 API（白名单放行全部，需确认）后再添加
 * - 未安装 → 不展示该面板
 *
 * 安全：探测到的 api_key 仅在本组件内存中短暂停留，保存时经 connSave
 * 写入后端 Vault（config JSON 清空明文），不传给 AI / 不日志输出。
 */
export function PanelProbeSection({ resourceId, connection }: Props) {
  const { t } = useI18n();
  const { result, loading, error, refresh } = usePanelProbe(resourceId);
  const connections = useConnectionStore((s) => s.connections);
  const saveConn = useConnectionStore((s) => s.save);
  const [adding, setAdding] = useState<string | null>(null);
  const [enabling, setEnabling] = useState<string | null>(null);

  // 从 SSH connection 提取真实 host，替换探测结果里的 127.0.0.1
  const sshHost = useMemo(() => {
    if (!connection) return null;
    const cfg = parseSshConfig(connection);
    return (cfg?.publicIp || cfg?.host || "").trim() || null;
  }, [connection]);

  // 当前 SSH 已关联的 panel connection（避免重复添加）
  const linkedPanel = useMemo(() => {
    if (!connection) return null;
    return findPanelForSsh(connections, connection.id) ?? null;
  }, [connections, connection]);

  // 把探测结果里的 127.0.0.1 替换为真实 host（面板地址对外应该是可达的）
  const realAddress = useCallback(
    (panel: PanelProbeItem): string => {
      if (!panel.address) return "";
      if (!sshHost) return panel.address;
      return panel.address.replace("127.0.0.1", sshHost);
    },
    [sshHost],
  );

  const panelTypeLabel = useCallback(
    (kind: string) => (kind === "bt" ? "宝塔" : "1Panel"),
    [],
  );

  const handleEnableApi = useCallback(
    async (panel: PanelProbeItem) => {
      const typeLabel = panelTypeLabel(panel.kind);
      const ok = await appConfirm(
        t("ssh.panelProbe.enableApiMsg", { type: typeLabel }),
        t("ssh.panelProbe.enableApiTitle"),
        {
          confirmLabel: t("ssh.panelProbe.enableApiConfirm"),
          kind: "warning",
        },
      );
      if (!ok) return;

      setEnabling(panel.kind);
      try {
        const res = await unwrapCommand(
          commands.sshPoolEnablePanelApi(resourceId, panel.kind, true),
        );
        showToast(t("ssh.panelProbe.enableApiOk", { message: res.message }));
        refresh();
      } catch (e) {
        showToast(formatIpcError(e));
      } finally {
        setEnabling(null);
      }
    },
    [resourceId, panelTypeLabel, t, refresh],
  );

  const handleAdd = useCallback(
    async (panel: PanelProbeItem) => {
      if (!connection) return;
      const addr = realAddress(panel);
      const serviceType = panel.kind === "bt" ? "bt" : "1panel";

      // 已关联同类型 panel：提示是否覆盖
      if (linkedPanel) {
        const ok = await appConfirm(
          t("ssh.panelProbe.overwriteMsg", { name: linkedPanel.name }),
          t("ssh.panelProbe.overwriteTitle"),
        );
        if (!ok) return;
      }

      setAdding(panel.kind);
      try {
        const form = {
          name:
            connection.name && connection.name.trim()
              ? `${connection.name} · ${serviceType === "bt" ? "宝塔" : "1Panel"}`
              : `${sshHost ?? "host"} · ${serviceType === "bt" ? "宝塔" : "1Panel"}`,
          group: connection.group || "默认",
          host: sshHost ?? "",
          port: "22",
          user: parseSshConfig(connection)?.user ?? "root",
          authType: "password" as const,
          password: "",
          pem: "",
          keyPath: "auto",
          passphrase: "",
          panelAddress: addr,
          panelKey: panel.apiKey ?? "",
          serviceType: serviceType as "bt" | "1panel",
          remark: "",
        };

        const draft = buildPanelConnection(
          form,
          connection.group || "默认",
          connection.id,
          linkedPanel?.id,
          linkedPanel?.createdAt,
        );

        const saved = await saveConn(draft);
        if (!saved?.id) throw new Error("保存失败");

        if (panel.apiKey) {
          showToast(t("ssh.panelProbe.addedWithKey", { type: panel.kind }));
        } else {
          showToast(t("ssh.panelProbe.addedNoKey", { type: panel.kind }));
        }
        refresh();
      } catch (e) {
        showToast(String(e));
      } finally {
        setAdding(null);
      }
    },
    [connection, linkedPanel, realAddress, sshHost, saveConn, t, refresh],
  );

  const installedPanels = useMemo(() => {
    if (!result) return [];
    const panels = Array.isArray(result.panels) ? result.panels : [];
    return panels.filter((p) => p?.installed);
  }, [result]);

  // 探测完成但没装任何面板：展示"未检测到"提示（而非隐藏，让用户知道功能存在）
  const showEmpty = result && !loading && installedPanels.length === 0;

  return (
    <section className="capabilities__group capabilities__group--panel">
      <h4 className="capabilities__group-title">
        {t("ssh.panelProbe.title")}
        <span className="capabilities__group-count">{installedPanels.length}</span>
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

      {loading && !result ? (
        <div className="capabilities__empty">{t("common.loading")}</div>
      ) : null}

      {error ? <div className="capabilities__error">{error}</div> : null}

      {showEmpty ? (
        <div className="capabilities__empty">{t("ssh.panelProbe.noneDetected")}</div>
      ) : null}

      <div className="capabilities__list">
        {installedPanels.map((panel) => {
          const addr = realAddress(panel);
          const isLinked = linkedPanel?.id != null;
          const sameKind = isLinked && linkedPanel != null;
          const isAdding = adding === panel.kind;
          const isEnabling = enabling === panel.kind;
          const busy = isAdding || isEnabling || loading;
          return (
            <div key={panel.kind} className="capabilities__tool">
              <div className="capabilities__tool-head">
                <span className="capabilities__tool-name">
                  <BrandIconImg
                    kind={panel.kind === "bt" ? "bt" : "1panel"}
                    size={14}
                    className="server-tree-brand-icon"
                  />
                  {panel.kind === "bt" ? "宝塔面板" : "1Panel"}
                </span>
                <span
                  className={
                    panel.apiEnabled
                      ? "cap-badge cap-badge--ok"
                      : "cap-badge cap-badge--warn"
                  }
                >
                  {panel.apiEnabled
                    ? t("ssh.panelProbe.apiOn")
                    : t("ssh.panelProbe.apiOff")}
                </span>
              </div>
              <div className="capabilities__tool-detail">
                <span className="cap-detail">{addr}</span>
                {panel.note ? (
                  <span className="cap-detail cap-detail--path">{panel.note}</span>
                ) : null}
                {panel.entrance ? (
                  <span className="cap-detail cap-detail--path">
                    {t("ssh.panelProbe.entrance")}: {panel.entrance}
                  </span>
                ) : null}
                {panel.apiKey ? (
                  <span className="cap-detail cap-detail--ok">
                    {panel.apiEnabled
                      ? t("ssh.panelProbe.keyDetected")
                      : t("ssh.panelProbe.keyButApiOff")}
                  </span>
                ) : (
                  <span className="cap-detail cap-detail--warn">
                    {t("ssh.panelProbe.needKey")}
                  </span>
                )}
              </div>
              <div className="capabilities__tool-actions">
                {!panel.apiEnabled ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void handleEnableApi(panel)}
                    disabled={busy}
                    title={t("ssh.panelProbe.enableApiHint")}
                  >
                    {isEnabling
                      ? t("ssh.panelProbe.enablingApi")
                      : t("ssh.panelProbe.enableApi")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void handleAdd(panel)}
                  disabled={busy}
                  title={
                    panel.apiKey
                      ? t("ssh.panelProbe.addWithKeyHint")
                      : t("ssh.panelProbe.addNoKeyHint")
                  }
                >
                  {isAdding
                    ? t("common.loading")
                    : isLinked && sameKind
                      ? t("ssh.panelProbe.update")
                      : t("ssh.panelProbe.addToPanel")}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
