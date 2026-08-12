import { useCallback, useEffect, useMemo, useState } from "react";
import { Select, type SelectOption } from "../../../components/ui/form/Select";
import { useI18n } from "../../../i18n";
import { useDockerSidebarCacheStore } from "../../../stores/dockerSidebarCacheStore";
import { fetchComposeProjects } from "../../docker/dockerComposeApi";
import { containerRowLabel } from "../../docker/dockerResourceLabels";
import { selectDockerSidebarCacheEntry } from "../../docker/dockerSidebarCache";
import type { HomeCustomPanelWidgetTarget } from "./types";

export type DockerTargetSelectProps = {
  connectionId: string | null;
  targetKind: "docker-container" | "docker-compose";
  value: HomeCustomPanelWidgetTarget | undefined;
  onChange: (target: HomeCustomPanelWidgetTarget | null) => void;
  className?: string;
  disabled?: boolean;
};

/** Docker 二级目标：容器 id 或 Compose 项目名 */
export function DockerTargetSelect({
  connectionId,
  targetKind,
  value,
  onChange,
  className,
  disabled,
}: DockerTargetSelectProps) {
  const { t } = useI18n();
  const [composeOptions, setComposeOptions] = useState<SelectOption[]>([]);
  const [composeLoading, setComposeLoading] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);

  const sidebarSelector = useCallback(
    selectDockerSidebarCacheEntry(connectionId ?? ""),
    [connectionId],
  );
  const sidebarEntry = useDockerSidebarCacheStore(sidebarSelector);
  const refreshScope = useDockerSidebarCacheStore((s) => s.refreshScope);

  useEffect(() => {
    if (!connectionId || targetKind !== "docker-container") return;
    if (sidebarEntry.containers.length > 0) return;
    void refreshScope({
      kind: "category",
      connectionId,
      category: "containers",
    }).catch(() => {});
  }, [
    connectionId,
    refreshScope,
    sidebarEntry.containers.length,
    targetKind,
  ]);

  useEffect(() => {
    if (!connectionId || targetKind !== "docker-compose") {
      setComposeOptions([]);
      setComposeError(null);
      return;
    }
    let cancelled = false;
    setComposeLoading(true);
    setComposeError(null);
    void fetchComposeProjects(connectionId)
      .then((projects) => {
        if (cancelled) return;
        setComposeOptions(
          projects
            .map((p) => ({
              value: p.name,
              label: p.name,
              subtitle: t(
                "homeWorkspace.widgets.dockerComposeMonitor.projectMeta",
                {
                  running: p.runningContainerCount,
                  total: p.containerCount,
                },
              ),
            }))
            .sort((a, b) => a.label.localeCompare(b.label, "zh-CN")),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setComposeOptions([]);
        setComposeError(String(err));
      })
      .finally(() => {
        if (!cancelled) setComposeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, t, targetKind]);

  const containerOptions = useMemo<SelectOption[]>(() => {
    if (targetKind !== "docker-container") return [];
    return sidebarEntry.containers
      .map((c) => ({
        value: c.id,
        label: containerRowLabel(c),
        subtitle: [
          c.running
            ? t("docker.dockPanel.statusRunning")
            : t("docker.dockPanel.statusStopped"),
          c.image,
        ]
          .filter(Boolean)
          .join(" · "),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
  }, [sidebarEntry.containers, t, targetKind]);

  const options =
    targetKind === "docker-container" ? containerOptions : composeOptions;

  const selectedValue =
    value?.kind === targetKind
      ? targetKind === "docker-container" && value.kind === "docker-container"
        ? value.containerId
        : targetKind === "docker-compose" && value.kind === "docker-compose"
          ? value.composeProject
          : ""
      : "";

  const placeholder = !connectionId
    ? t("homeWorkspace.customPanel.target.needConnection")
    : targetKind === "docker-container"
      ? t("homeWorkspace.customPanel.target.placeholderContainer")
      : t("homeWorkspace.customPanel.target.placeholderCompose");

  const emptyText =
    composeError ??
    (composeLoading
      ? t("common.loading")
      : targetKind === "docker-container"
        ? t("homeWorkspace.customPanel.target.emptyContainer")
        : t("homeWorkspace.customPanel.target.emptyCompose"));

  return (
    <Select
      size="sm"
      searchable
      disabled={disabled || !connectionId}
      className={className}
      value={selectedValue}
      onChange={(next) => {
        const id = next.trim();
        if (!id) {
          onChange(null);
          return;
        }
        if (targetKind === "docker-container") {
          onChange({ kind: "docker-container", containerId: id });
        } else {
          onChange({ kind: "docker-compose", composeProject: id });
        }
      }}
      placeholder={placeholder}
      emptyText={emptyText}
      aria-label={
        targetKind === "docker-container"
          ? t("homeWorkspace.customPanel.target.container")
          : t("homeWorkspace.customPanel.target.compose")
      }
      options={options}
      panelMinWidth={240}
    />
  );
}
