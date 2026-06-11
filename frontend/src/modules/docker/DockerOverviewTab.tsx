import { useMemo } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import type {
  DockerComposeProject,
  DockerConnectionInfo,
  DockerImageSummary,
  DockerNetworkSummary,
  DockerOverview,
  DockerProbe,
  DockerSystemDiskUsage,
  DockerVolumeSummary,
} from "../../ipc/bindings";
import type { DockerWorkspaceTab } from "./dockerWorkspaceTabs";

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function engineEndpointLabel(connection: DockerConnectionInfo | null): string {
  if (!connection) return "—";
  if (connection.hostLabel) return connection.hostLabel;
  switch (connection.source) {
    case "local-engine":
      return "unix:///var/run/docker.sock";
    case "remote-engine":
      return "tcp://remote-engine";
    case "ssh-engine":
      return "ssh://docker";
    case "one-panel":
    case "panel-adapter":
      return connection.name;
    default:
      return connection.source;
  }
}

interface DiskUsageRow {
  label: string;
  usedBytes: number | null;
  reclaimableBytes: number | null;
  canRelease: boolean;
  onRelease?: () => void;
}

interface Props {
  overview: DockerOverview | null;
  systemDiskUsage: DockerSystemDiskUsage | null;
  probe: DockerProbe | null;
  connection: DockerConnectionInfo | null;
  containersTotal: number;
  containersRunning: number;
  images: DockerImageSummary[];
  composeProjects: DockerComposeProject[];
  networks: DockerNetworkSummary[];
  volumes: DockerVolumeSummary[];
  dataLoading: boolean;
  dataRefreshing: boolean;
  canManage: boolean;
  onNavigateTab: (tab: DockerWorkspaceTab) => void;
  onEditConnection: () => void;
  onPruneImages: () => void;
  onPruneVolumes: () => void;
  onPruneBuildCache: () => void;
}

function diskItemBytes(value: number | null | undefined): number | null {
  if (value == null || value < 0) return null;
  return value;
}

export function DockerOverviewTab({
  overview,
  systemDiskUsage,
  probe,
  connection,
  containersTotal,
  containersRunning,
  images,
  composeProjects,
  networks,
  volumes,
  dataLoading,
  dataRefreshing,
  canManage,
  onNavigateTab,
  onEditConnection,
  onPruneImages,
  onPruneVolumes,
  onPruneBuildCache,
}: Props) {
  const { t } = useI18n();

  const diskRows = useMemo((): DiskUsageRow[] => {
    const fallbackImageUsed = images.reduce((sum, img) => sum + Math.max(img.sizeBytes ?? 0, 0), 0);
    const fallbackImageReclaimable = images
      .filter((img) => img.dangling)
      .reduce((sum, img) => sum + Math.max(img.sizeBytes ?? 0, 0), 0);
    const fallbackVolumeUsed = volumes.reduce((sum, vol) => sum + Math.max(vol.sizeBytes ?? 0, 0), 0);
    const fallbackVolumeReclaimable = volumes
      .filter((vol) => !vol.inUse)
      .reduce((sum, vol) => sum + Math.max(vol.sizeBytes ?? 0, 0), 0);

    const imagesUsed = diskItemBytes(systemDiskUsage?.images.sizeBytes) ?? (fallbackImageUsed || null);
    const imagesReclaimable =
      diskItemBytes(systemDiskUsage?.images.reclaimableBytes) ?? (fallbackImageReclaimable || null);
    const containersUsed = diskItemBytes(systemDiskUsage?.containers.sizeBytes);
    const containersReclaimable = diskItemBytes(systemDiskUsage?.containers.reclaimableBytes);
    const volumesUsed = diskItemBytes(systemDiskUsage?.volumes.sizeBytes) ?? (fallbackVolumeUsed || null);
    const volumesReclaimable =
      diskItemBytes(systemDiskUsage?.volumes.reclaimableBytes) ?? (fallbackVolumeReclaimable || null);
    const buildCacheUsed = diskItemBytes(systemDiskUsage?.buildCache.sizeBytes);
    const buildCacheReclaimable = diskItemBytes(systemDiskUsage?.buildCache.reclaimableBytes);

    return [
      {
        label: t("docker.overview.disk.images"),
        usedBytes: imagesUsed,
        reclaimableBytes: imagesReclaimable,
        canRelease: canManage && (imagesReclaimable ?? 0) > 0,
        onRelease: onPruneImages,
      },
      {
        label: t("docker.overview.disk.containers"),
        usedBytes: containersUsed,
        reclaimableBytes: containersReclaimable,
        canRelease: false,
      },
      {
        label: t("docker.overview.disk.volumes"),
        usedBytes: volumesUsed,
        reclaimableBytes: volumesReclaimable,
        canRelease: canManage && (volumesReclaimable ?? 0) > 0,
        onRelease: onPruneVolumes,
      },
      {
        label: t("docker.overview.disk.buildCache"),
        usedBytes: buildCacheUsed,
        reclaimableBytes: buildCacheReclaimable,
        canRelease: canManage && (buildCacheReclaimable ?? 0) > 0,
        onRelease: onPruneBuildCache,
      },
    ];
  }, [
    systemDiskUsage,
    images,
    volumes,
    canManage,
    onPruneImages,
    onPruneVolumes,
    onPruneBuildCache,
    t,
  ]);

  const resourceCards = useMemo(
    () => [
      { tab: "compose" as const, label: t("docker.tabs.compose"), value: composeProjects.length },
      { tab: null, label: t("docker.overview.composeTemplates"), value: null },
      { tab: "images" as const, label: t("docker.tabs.images"), value: images.length },
      { tab: null, label: t("docker.overview.registries"), value: null },
      { tab: "networks" as const, label: t("docker.tabs.networks"), value: networks.length },
      { tab: "volumes" as const, label: t("docker.tabs.volumes"), value: volumes.length },
    ],
    [composeProjects.length, images.length, networks.length, volumes.length, t],
  );

  const totalContainers = overview?.summary.containersTotal ?? containersTotal;
  const runningContainers = overview?.summary.containersRunning ?? containersRunning;

  return (
    <div className="docker-overview">
      {dataRefreshing && (
        <div className="docker-overview-refresh-hint text-muted text-xs">
          {t("docker.overview.refreshing")}
        </div>
      )}

      <section className="docker-overview-section">
        <div className="docker-overview-section-head">
          <h3 className="docker-overview-section-title">{t("docker.tabs.containers")}</h3>
          <div className="docker-overview-badges">
            <span className="badge badge-muted">
              {t("docker.filters.all")} {totalContainers}
            </span>
            <span className="badge badge-accent">
              {t("docker.filters.running")} {runningContainers}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="docker-overview-hero"
          onClick={() => onNavigateTab("containers")}
        >
          <span className="docker-overview-hero-value">
            {dataLoading && totalContainers === 0 ? "…" : totalContainers}
          </span>
        </button>
      </section>

      <div className="docker-overview-stat-grid">
        {resourceCards.map((card) => (
          <button
            key={card.label}
            type="button"
            className={`docker-overview-stat-card${card.tab ? "" : " docker-overview-stat-card--static"}`}
            disabled={!card.tab}
            onClick={() => card.tab && onNavigateTab(card.tab)}
          >
            <div className="docker-overview-stat-card-label">{card.label}</div>
            <div className="docker-overview-stat-card-value">
              {card.value == null ? "—" : card.value}
            </div>
          </button>
        ))}
      </div>

      <section className="docker-overview-section">
        <h3 className="docker-overview-section-title">{t("docker.overview.disk.title")}</h3>
        <div className="docker-overview-disk-grid">
          {diskRows.map((row) => (
            <div key={row.label} className="docker-overview-disk-item">
              <div className="docker-overview-disk-label">{row.label}</div>
              <div className="docker-overview-disk-meta text-sm text-muted">
                {t("docker.overview.disk.used")}: {formatBytes(row.usedBytes)}
                <br />
                {t("docker.overview.disk.reclaimable")}: {formatBytes(row.reclaimableBytes)}
              </div>
              {row.canRelease && row.onRelease ? (
                <button type="button" className="docker-overview-release" onClick={row.onRelease}>
                  {t("docker.overview.disk.release")}
                </button>
              ) : (
                <span className="docker-overview-release docker-overview-release--disabled">
                  {t("docker.overview.disk.release")}
                </span>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="docker-overview-section">
        <h3 className="docker-overview-section-title">{t("docker.overview.config.title")}</h3>
        <dl className="docker-overview-kv">
          <dt>{t("docker.overview.config.endpoint")}</dt>
          <dd className="text-muted">{engineEndpointLabel(connection)}</dd>
          <dt>{t("docker.overview.config.engine")}</dt>
          <dd>{overview?.engineVersion ?? probe?.engineVersion ?? connection?.engineVersion ?? "—"}</dd>
          <dt>{t("docker.overview.config.api")}</dt>
          <dd className="text-muted">{probe?.apiVersion ?? connection?.apiVersion ?? "—"}</dd>
          <dt>{t("docker.overview.config.source")}</dt>
          <dd className="text-muted">{connection?.source ?? "—"}</dd>
        </dl>
        <div className="docker-overview-config-actions">
          <Button variant="secondary" size="sm" onClick={onEditConnection}>
            {t("docker.overview.config.editConnection")}
          </Button>
        </div>
      </section>
    </div>
  );
}
