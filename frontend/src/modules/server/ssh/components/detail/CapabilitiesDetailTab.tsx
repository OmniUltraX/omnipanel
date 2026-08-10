import { useCallback, useEffect, useMemo } from "react";

import { appConfirm } from "@/lib/appConfirm";
import { useI18n } from "@/i18n";
import { asArray } from "@/ipc/asArray";
import type { WorkspaceResource } from "@/lib/resourceRegistry";
import { showToast } from "@/stores/toastStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type {
  InstallMethod,
  RemoteToolCapability,
  ToolCategory,
  ToolState,
} from "@/ipc/bindings";

import { selectCapabilities, useCapabilitiesStore } from "../../stores/capabilitiesStore";
import { PanelProbeSection } from "./PanelProbeSection";

type Props = {
  activeResource: WorkspaceResource | null;
};

/** 工具分类的展示顺序。 */
const CATEGORY_ORDER: ToolCategory[] = [
  "terminal",
  "database",
  "archive",
  "transfer",
  "monitoring",
  "system",
];

/** 探测耗时阈值：超过则标黄提示。 */
const SLOW_PROBE_MS = 3000;

function formatProbedAt(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString();
}

/** 状态徽章的样式类与文案 key。 */
function stateBadge(state: ToolState): { className: string; key: string } {
  switch (state.kind) {
    case "ready":
      return { className: "cap-badge cap-badge--ok", key: "ssh.toolCapabilities.states.ready" };
    case "needInstall":
      return { className: "cap-badge cap-badge--warn", key: "ssh.toolCapabilities.states.needInstall" };
    case "tooOld":
      return { className: "cap-badge cap-badge--warn", key: "ssh.toolCapabilities.states.tooOld" };
    case "unsupported":
      return { className: "cap-badge cap-badge--muted", key: "ssh.toolCapabilities.states.unsupported" };
  }
}

/** 判断某工具是否可一键安装（包管理器 / 二进制下载 / 远端脚本编译）。 */
function isAutoInstallable(method: InstallMethod): boolean {
  return (
    method.kind === "packageManager" ||
    method.kind === "downloadBinary" ||
    method.kind === "shellScript"
  );
}

/** 手动安装指引文案。 */
function manualInstructions(method: InstallMethod): string | null {
  return method.kind === "manual" ? method.instructions : null;
}

/**
 * 远端工具能力统一治理视图。
 *
 * 一次批量探测（1 RTT）覆盖所有轻量命令工具，重型工具走懒探测。结果按主机缓存
 * 5 分钟（后端 TTL），前端 store 再做一层跨 Tab 共享。安装后原地更新单工具状态，
 * 无需全量重探。手动安装工具提供「复制命令」按钮。
 */
export function CapabilitiesDetailTab({ activeResource }: Props) {
  const { t } = useI18n();
  const resourceId = activeResource?.id ?? null;
  const connections = useConnectionStore((s) => s.connections);
  const connection = useMemo(
    () => (resourceId ? connections.find((c) => c.id === resourceId) ?? null : null),
    [connections, resourceId],
  );

  const entry = useCapabilitiesStore((s) => selectCapabilities(s, resourceId));
  const probe = useCapabilitiesStore((s) => s.probe);
  const installTool = useCapabilitiesStore((s) => s.installTool);

  const load = useCallback(
    (force: boolean) => {
      if (!resourceId) return;
      void probe(resourceId, force);
    },
    [resourceId, probe],
  );

  // 首次进入或切换主机时自动探测（后端有缓存，不会重复打远端）
  useEffect(() => {
    if (resourceId && !entry.result && !entry.loading) {
      void probe(resourceId, false);
    }
  }, [resourceId, entry.result, entry.loading, probe]);

  const tools = useMemo(
    () => asArray<RemoteToolCapability>(entry.result?.tools),
    [entry.result],
  );

  const grouped = useMemo(() => {
    if (!entry.result) return [] as { category: ToolCategory; tools: RemoteToolCapability[] }[];
    const map = new Map<ToolCategory, RemoteToolCapability[]>();
    for (const tool of tools) {
      const list = map.get(tool.category) ?? [];
      list.push(tool);
      map.set(tool.category, list);
    }
    return CATEGORY_ORDER.filter((c) => map.has(c)).map((category) => ({
      category,
      tools: map.get(category)!,
    }));
  }, [entry.result, tools]);

  const handleInstall = useCallback(
    async (tool: RemoteToolCapability) => {
      if (!resourceId) return;
      // 源码编译安装耗时较长（数分钟）且会装编译依赖，先确认
      if (tool.installMethod.kind === "shellScript") {
        const ok = await appConfirm(
          t("ssh.toolCapabilities.buildConfirmMsg", { name: tool.id }),
          t("ssh.toolCapabilities.buildConfirmTitle"),
        );
        if (!ok) return;
      }
      const res = await installTool(resourceId, tool.id);
      if (res?.installed) {
        showToast(t("ssh.toolCapabilities.installDone", { name: tool.id }));
      } else if (res) {
        showToast(res.message || t("ssh.toolCapabilities.installFailed"));
      }
    },
    [resourceId, installTool, t],
  );

  const handleCopyManual = useCallback(
    async (instructions: string) => {
      try {
        await navigator.clipboard.writeText(instructions);
        showToast(t("ssh.toolCapabilities.copyDone"));
      } catch {
        showToast(t("ssh.toolCapabilities.copyFailed"));
      }
    },
    [t],
  );

  const result = entry.result;
  const isSlow = result != null && result.elapsedMs > SLOW_PROBE_MS;

  return (
    <div className="capabilities">
      <div className="capabilities__header">
        <div className="capabilities__intro">{t("ssh.toolCapabilities.intro")}</div>
        <div className="capabilities__header-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => load(true)}
            disabled={entry.loading || !resourceId}
            title={t("ssh.toolCapabilities.refreshHint")}
          >
            {entry.loading ? t("common.loading") : t("common.refresh")}
          </button>
        </div>
      </div>

      {result ? (
        <div className="capabilities__meta">
          <span className={`cap-meta${isSlow ? " cap-meta--slow" : ""}`}>
            {t("ssh.toolCapabilities.elapsed", { ms: result.elapsedMs })}
          </span>
          <span className="cap-meta">
            {t("ssh.toolCapabilities.probedAt", { time: formatProbedAt(result.probedAt) })}
          </span>
          <span className="cap-meta cap-meta--count">
            {t("ssh.toolCapabilities.toolCount", { count: tools.length })}
          </span>
        </div>
      ) : null}

      {entry.error ? <div className="capabilities__error">{entry.error}</div> : null}

      {entry.loading && !result ? (
        <div className="capabilities__empty">{t("common.loading")}</div>
      ) : null}

      {!entry.loading && !entry.error && grouped.length === 0 ? (
        <div className="capabilities__empty">{t("ssh.toolCapabilities.empty")}</div>
      ) : null}

      {grouped.map(({ category, tools: groupTools }) => (
        <section key={category} className="capabilities__group">
          <h4 className="capabilities__group-title">
            {t(`ssh.toolCapabilities.categories.${category}`)}
            <span className="capabilities__group-count">{groupTools.length}</span>
          </h4>
          <div className="capabilities__list">
            {groupTools.map((tool) => {
              const badge = stateBadge(tool.state);
              const installing = entry.installing[tool.id] === true;
              const autoInstall = isAutoInstallable(tool.installMethod);
              const manual = manualInstructions(tool.installMethod);
              return (
                <div key={tool.id} className="capabilities__tool">
                  <div className="capabilities__tool-head">
                    <span className="capabilities__tool-name">{tool.id}</span>
                    <span className={badge.className}>{t(badge.key)}</span>
                  </div>
                  <div className="capabilities__tool-detail">
                    <ToolStateText state={tool.state} t={t} />
                  </div>
                  <div className="capabilities__tool-actions">
                    {autoInstall ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void handleInstall(tool)}
                        disabled={installing || tool.state.kind === "ready"}
                        title={
                          tool.installMethod.kind === "downloadBinary"
                            ? t("ssh.toolCapabilities.downloadHint")
                            : tool.installMethod.kind === "shellScript"
                              ? t("ssh.toolCapabilities.buildHint")
                              : t("ssh.toolCapabilities.installHint")
                        }
                      >
                        {installing
                          ? t("common.loading")
                          : tool.installMethod.kind === "downloadBinary"
                            ? t("ssh.toolCapabilities.download")
                            : tool.installMethod.kind === "shellScript"
                              ? t("ssh.toolCapabilities.build")
                              : t("ssh.toolCapabilities.install")}
                      </button>
                    ) : null}
                    {manual ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void handleCopyManual(manual)}
                        title={t("ssh.toolCapabilities.copyHint")}
                      >
                        {t("ssh.toolCapabilities.copyCommand")}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {resourceId ? (
        <PanelProbeSection resourceId={resourceId} connection={connection} />
      ) : null}
    </div>
  );
}

/** 工具状态的可读描述。 */
function ToolStateText({
  state,
  t,
}: {
  state: ToolState;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  switch (state.kind) {
    case "ready":
      if (state.version && state.path) {
        return (
          <>
            <span className="cap-detail">{state.version}</span>
            <span className="cap-detail cap-detail--path">{state.path}</span>
          </>
        );
      }
      if (state.version) return <span className="cap-detail">{state.version}</span>;
      if (state.path) return <span className="cap-detail cap-detail--path">{state.path}</span>;
      return <span className="cap-detail cap-detail--muted">{t("ssh.toolCapabilities.states.readyNoVersion")}</span>;
    case "needInstall":
      return <span className="cap-detail cap-detail--muted">{t("ssh.toolCapabilities.states.needInstallDesc")}</span>;
    case "tooOld":
      return (
        <span className="cap-detail cap-detail--warn">
          {t("ssh.toolCapabilities.states.tooOldDesc", {
            version: state.version,
            required: state.required,
          })}
        </span>
      );
    case "unsupported":
      return (
        <span className="cap-detail cap-detail--muted">
          {t("ssh.toolCapabilities.states.unsupportedDesc")}
        </span>
      );
  }
}
