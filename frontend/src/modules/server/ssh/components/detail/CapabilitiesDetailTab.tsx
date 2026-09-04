import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { appConfirm } from "@/lib/appConfirm";
import { useI18n } from "@/i18n";
import { asArray } from "@/ipc/asArray";
import type { WorkspaceResource } from "@/lib/resourceRegistry";
import { showToast } from "@/stores/toastStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { getEngineIcon } from "@/modules/database/connection/engineIcons";
import type {
  Connection,
  InstallMethod,
  RemoteToolCapability,
  ToolState,
} from "@/ipc/bindings";

import { BrandIconImg } from "../../../brandIcons";
import nginxIcon from "@/assets/icons/nginx.svg";

import { selectCapabilities, useCapabilitiesStore } from "../../stores/capabilitiesStore";
import { DockerConnectionDialog } from "@/modules/docker/DockerConnectionDialog";
import { WorkbenchActionButton } from "@/components/ui/primitives/WorkbenchActionButton";
import { PanelProbeSection } from "./PanelProbeSection";

type Props = {
  activeResource: WorkspaceResource | null;
};

/** 前端展示分组（与后端 ToolCategory 解耦）。 */
type UiGroupId = "ops" | "storage" | "basic";

const UI_GROUPS: ReadonlyArray<{ id: UiGroupId; toolIds: readonly string[] }> = [
  {
    id: "ops",
    toolIds: ["docker", "nginx"],
  },
  {
    id: "storage",
    toolIds: ["my2sql", "redis-cli"],
  },
  {
    id: "basic",
    toolIds: ["tmux", "unzip", "tar", "7z", "unrar", "zstd", "rsync"],
  },
];

/** 探测耗时阈值：超过则标黄提示。 */
const SLOW_PROBE_MS = 3000;

function formatProbedAt(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString();
}

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

function cardTone(state: ToolState): string {
  switch (state.kind) {
    case "ready":
      return "capabilities__card--ready";
    case "needInstall":
    case "tooOld":
      return "capabilities__card--warn";
    case "unsupported":
      return "capabilities__card--muted";
  }
}

function isAutoInstallable(method: InstallMethod): boolean {
  return (
    method.kind === "packageManager" ||
    method.kind === "downloadBinary" ||
    method.kind === "shellScript"
  );
}

function manualInstructions(method: InstallMethod): string | null {
  return method.kind === "manual" ? method.instructions : null;
}

function installButtonLabel(
  method: InstallMethod,
  installing: boolean,
  t: (key: string) => string,
): string {
  if (installing) return t("common.loading");
  if (method.kind === "downloadBinary") return t("ssh.toolCapabilities.download");
  if (method.kind === "shellScript") return t("ssh.toolCapabilities.build");
  return t("ssh.toolCapabilities.install");
}

function readyVersion(state: ToolState): string | null {
  if (state.kind !== "ready") return null;
  return state.version?.trim() || null;
}

function CapabilityBrandIcon({ toolId }: { toolId: string }) {
  const theme = useSettingsStore((s) => s.resolved);
  if (toolId === "docker") {
    return <BrandIconImg kind="docker" size={16} className="capabilities__card-icon" />;
  }
  if (toolId === "nginx") {
    return (
      <img
        src={nginxIcon}
        alt=""
        width={16}
        height={16}
        className="capabilities__card-icon"
        draggable={false}
        aria-hidden
      />
    );
  }
  if (toolId === "my2sql") {
    const src = getEngineIcon("mysql", theme);
    return src ? (
      <img
        src={src}
        alt=""
        width={16}
        height={16}
        className="capabilities__card-icon"
        draggable={false}
        aria-hidden
      />
    ) : null;
  }
  if (toolId === "redis-cli") {
    const src = getEngineIcon("redis", theme);
    return src ? (
      <img
        src={src}
        alt=""
        width={16}
        height={16}
        className="capabilities__card-icon"
        draggable={false}
        aria-hidden
      />
    ) : null;
  }
  return null;
}

/**
 * 远端工具能力统一治理视图。
 *
 * 按运维 / 存储 / 基础三类展示；运维组卡片与面板探测同一行横向排列。
 * 批量探测缓存 5 分钟，安装后原地更新单工具状态。
 */
export function CapabilitiesDetailTab({ activeResource }: Props) {
  const { t } = useI18n();
  const resourceId = activeResource?.id ?? null;
  const connections = useConnectionStore((s) => s.connections);
  const connection = useMemo(
    () => (resourceId ? connections.find((c) => c.id === resourceId) ?? null : null),
    [connections, resourceId],
  );
  const [dockerDialogOpen, setDockerDialogOpen] = useState(false);
  const [dockerBindSsh, setDockerBindSsh] = useState<Connection | null>(null);

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

  useEffect(() => {
    if (resourceId && !entry.result && !entry.loading) {
      void probe(resourceId, false);
    }
  }, [resourceId, entry.result, entry.loading, probe]);

  const toolsById = useMemo(() => {
    const map = new Map<string, RemoteToolCapability>();
    for (const tool of asArray<RemoteToolCapability>(entry.result?.tools)) {
      map.set(tool.id, tool);
    }
    return map;
  }, [entry.result]);

  const grouped = useMemo(() => {
    return UI_GROUPS.map((group) => ({
      id: group.id,
      tools: group.toolIds
        .map((id) => toolsById.get(id))
        .filter((tool): tool is RemoteToolCapability => Boolean(tool)),
    })).filter((g) => g.id === "ops" || g.tools.length > 0);
  }, [toolsById]);

  const handleInstall = useCallback(
    async (tool: RemoteToolCapability) => {
      if (!resourceId) return;
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
  const visibleToolCount = grouped.reduce((n, g) => n + g.tools.length, 0);

  return (
    <>
    <div className="capabilities">
      <div className="capabilities__header">
        <div className="capabilities__header-actions">
          <WorkbenchActionButton
            onClick={() => load(true)}
            disabled={entry.loading || !resourceId}
            title={t("ssh.toolCapabilities.refreshHint")}
          >
            {entry.loading ? t("common.loading") : t("common.refresh")}
          </WorkbenchActionButton>
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
            {t("ssh.toolCapabilities.toolCount", { count: visibleToolCount })}
          </span>
        </div>
      ) : null}

      {entry.error ? <div className="capabilities__error">{entry.error}</div> : null}

      {entry.loading && !result ? (
        <div className="capabilities__empty">{t("common.loading")}</div>
      ) : null}

      {!entry.loading && !entry.error && !result ? (
        <div className="capabilities__empty">{t("ssh.toolCapabilities.empty")}</div>
      ) : null}

      {grouped.map((group) => (
        <section key={group.id} className="capabilities__group">
          <h4 className="capabilities__group-title">
            {t(`ssh.toolCapabilities.uiCategories.${group.id}`)}
            <span className="capabilities__group-count">{group.tools.length}</span>
          </h4>
          <div className="capabilities__list">
            {group.tools.map((tool) => (
              <ToolCapabilityCard
                key={tool.id}
                tool={tool}
                installing={entry.installing[tool.id] === true}
                onInstall={() => void handleInstall(tool)}
                onCopyManual={(text) => void handleCopyManual(text)}
                extraActions={
                  tool.id === "docker" && tool.state.kind === "ready" && connection ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        setDockerBindSsh(connection);
                        setDockerDialogOpen(true);
                      }}
                      title={t("ssh.toolCapabilities.quickManageDockerHint")}
                    >
                      {t("ssh.toolCapabilities.quickManage")}
                    </button>
                  ) : null
                }
                t={t}
              />
            ))}
            {group.id === "ops" && resourceId ? (
              <PanelProbeSection
                resourceId={resourceId}
                connection={connection}
                embedded
              />
            ) : null}
          </div>
        </section>
      ))}
    </div>
      <DockerConnectionDialog
        open={dockerDialogOpen}
        onClose={() => {
          setDockerDialogOpen(false);
          setDockerBindSsh(null);
        }}
        bindSshConnection={dockerBindSsh ?? undefined}
        onSaved={() => {
          setDockerDialogOpen(false);
          setDockerBindSsh(null);
        }}
      />
    </>
  );
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

function ToolCapabilityCard({
  tool,
  installing,
  onInstall,
  onCopyManual,
  extraActions,
  t,
}: {
  tool: RemoteToolCapability;
  installing: boolean;
  onInstall: () => void;
  onCopyManual: (instructions: string) => void;
  extraActions?: ReactNode;
  t: Translate;
}) {
  const badge = stateBadge(tool.state);
  const version = readyVersion(tool.state);
  const autoInstall = isAutoInstallable(tool.installMethod);
  const manual = manualInstructions(tool.installMethod);
  const canInstall =
    autoInstall && (tool.state.kind === "needInstall" || tool.state.kind === "tooOld");
  const displayName = (() => {
    if (tool.id === "nginx" && tool.state.kind === "ready") {
      const hay = `${tool.state.version ?? ""} ${tool.state.path ?? ""}`.toLowerCase();
      if (hay.includes("openresty")) return "OpenResty";
      return "Nginx";
    }
    const key = `ssh.toolCapabilities.tools.${tool.id}`;
    const label = t(key);
    return label === key ? tool.id : label;
  })();

  return (
    <article className={`capabilities__card ${cardTone(tool.state)}`}>
      <div className="capabilities__card-top">
        <div className="capabilities__card-title">
          <span className="capabilities__card-name">
            <CapabilityBrandIcon toolId={tool.id} />
            {displayName}
          </span>
          <span className="capabilities__card-id">{tool.id}</span>
        </div>
        <span className={badge.className}>{t(badge.key)}</span>
      </div>

      <div className="capabilities__card-body">
        {tool.state.kind === "ready" ? (
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
            {tool.state.path ? (
              <div className="capabilities__card-path" title={tool.state.path}>
                {tool.state.path}
              </div>
            ) : null}
          </>
        ) : (
          <ToolStateDetail state={tool.state} t={t} />
        )}
      </div>

      <div className="capabilities__card-actions">
        {canInstall ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onInstall}
            disabled={installing}
            title={
              tool.installMethod.kind === "downloadBinary"
                ? t("ssh.toolCapabilities.downloadHint")
                : tool.installMethod.kind === "shellScript"
                  ? t("ssh.toolCapabilities.buildHint")
                  : t("ssh.toolCapabilities.installHint")
            }
          >
            {installButtonLabel(tool.installMethod, installing, t)}
          </button>
        ) : null}
        {manual && tool.state.kind !== "ready" ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onCopyManual(manual)}
            title={t("ssh.toolCapabilities.copyHint")}
          >
            {t("ssh.toolCapabilities.copyCommand")}
          </button>
        ) : null}
        {tool.state.kind === "ready" ? (
          <span className="capabilities__card-installed">
            {t("ssh.toolCapabilities.installed")}
          </span>
        ) : null}
        {extraActions}
      </div>
    </article>
  );
}

function ToolStateDetail({ state, t }: { state: ToolState; t: Translate }) {
  switch (state.kind) {
    case "ready":
      return null;
    case "needInstall":
      return (
        <p className="capabilities__card-desc">
          {t("ssh.toolCapabilities.states.needInstallDesc")}
        </p>
      );
    case "tooOld":
      return (
        <p className="capabilities__card-desc capabilities__card-desc--warn">
          {t("ssh.toolCapabilities.states.tooOldDesc", {
            version: state.version,
            required: state.required,
          })}
        </p>
      );
    case "unsupported":
      return (
        <p className="capabilities__card-desc">
          {t("ssh.toolCapabilities.states.unsupportedDesc")}
        </p>
      );
  }
}
