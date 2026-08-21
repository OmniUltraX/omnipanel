import { useEffect, useMemo, useState } from "react";
import { Select, type SelectOption } from "../../../components/ui/form/Select";
import { useI18n } from "../../../i18n";
import {
  createBtPanelClient,
  isPidInfoPresent,
  type BtJavaProject,
} from "../../../lib/btpanel";
import { useConnectionStore } from "../../../stores/connectionStore";
import { connectionToServerEntry } from "../../server/panel/panelConnection";
import { parsePanelConfig } from "../../server/panel/serverConnection";
import type { HomeCustomPanelWidgetTarget } from "./types";
import { isBtPanelService } from "../../server/panel/panelPlugin";

export type BtJavaProjectTargetSelectProps = {
  connectionId: string | null;
  value: HomeCustomPanelWidgetTarget | null | undefined;
  onChange: (target: HomeCustomPanelWidgetTarget | null) => void;
  className?: string;
  disabled?: boolean;
  borderless?: boolean;
};

function projectLabel(project: BtJavaProject): string {
  return String(project.name ?? project.project_name ?? "").trim();
}

/** 宝塔 Java 项目二级目标选择（仅 panel + bt）。 */
export function BtJavaProjectTargetSelect({
  connectionId,
  value,
  onChange,
  className,
  disabled,
  borderless = false,
}: BtJavaProjectTargetSelectProps) {
  const { t } = useI18n();
  const connections = useConnectionStore((s) => s.connections);
  const [projects, setProjects] = useState<BtJavaProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connection = useMemo(
    () =>
      connectionId
        ? (connections.find((c) => c.id === connectionId && c.kind === "panel") ??
          null)
        : null,
    [connectionId, connections],
  );

  const isBt = useMemo(() => {
    if (!connection) return false;
    return isBtPanelService(parsePanelConfig(connection).serviceType);
  }, [connection]);

  useEffect(() => {
    let cancelled = false;
    if (!connection || !isBt) {
      setProjects([]);
      setError(null);
      setLoading(false);
      return;
    }
    const server = connectionToServerEntry(connection);
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const client = createBtPanelClient(server.address, server.key, server.id);
        const result = await client.getJavaProjectList({ limit: 200 });
        if (cancelled) return;
        setProjects(Array.isArray(result.data) ? result.data : []);
      } catch (err) {
        if (cancelled) return;
        setProjects([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, isBt]);

  const options = useMemo<SelectOption[]>(() => {
    const list: SelectOption[] = [];
    for (const p of projects) {
      const name = projectLabel(p);
      if (!name) continue;
      const running = "pid_info" in p ? isPidInfoPresent(p.pid_info) : null;
      const subtitle =
        running == null
          ? undefined
          : running
            ? t("homeWorkspace.widgets.btJavaWebsiteMonitor.statusRunning")
            : t("homeWorkspace.widgets.btJavaWebsiteMonitor.statusStopped");
      list.push({ value: name, label: name, subtitle });
    }
    return list.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
  }, [projects, t]);

  const selected =
    value?.kind === "bt-java-project" ? value.projectName : "";

  if (!connectionId) {
    return (
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        {t("homeWorkspace.customPanel.target.needPanelConnection")}
      </p>
    );
  }

  if (connection && !isBt) {
    return (
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        {t("homeWorkspace.widgets.btJavaWebsiteMonitor.needBtPanel")}
      </p>
    );
  }

  return (
    <Select
      size="sm"
      borderless={borderless}
      searchable
      disabled={disabled || loading}
      className={["home-custom-panel-widget__source", className]
        .filter(Boolean)
        .join(" ")}
      value={selected}
      onChange={(next) => {
        const name = next.trim();
        onChange(name ? { kind: "bt-java-project", projectName: name } : null);
      }}
      placeholder={
        loading
          ? t("homeWorkspace.widgets.btJavaWebsiteMonitor.loadingProjects")
          : t("homeWorkspace.customPanel.target.placeholderJavaProject")
      }
      emptyText={
        error
          ? error
          : t("homeWorkspace.customPanel.target.emptyJavaProject")
      }
      aria-label={t("homeWorkspace.customPanel.target.javaProject")}
      options={options}
      panelMinWidth={220}
    />
  );
}
