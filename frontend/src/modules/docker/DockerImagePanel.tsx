import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import { ScopedSearch } from "../../components/ui/search/ScopedSearch";
import { commands } from "../../ipc/bindings";
import type {
  DockerConnectionInfo,
  DockerContainerSummary,
  DockerImageSummary,
} from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useDockerSidebarCacheStore } from "../../stores/dockerSidebarCacheStore";
import { peekDockerSidebarCache } from "./dockerSidebarCacheSeed";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "../database/workspace/DbTablesPanelGrid";
import { DbPanelMetaRefreshButton } from "../database/workspace/DbPanelMetaRefreshButton";
import {
  containerTagsCopyValue,
  containersForImage,
  groupContainersByImageId,
} from "./dockerImageContainers";
import { DockerImagePullDialog } from "./DockerImagePullDialog";
import { dockerContainerMatchesSearch, dockerImageMatchesSearch } from "./dockerTreeSearch";
import { formatBytes } from "../../stores/sshStatsStore";
import { containerRowLabel, imageRowLabel, imageRowSizeLabel } from "./dockerResourceLabels";
import { DownloadIcon } from "./icons";

export interface DockerImagePanelProps {
  connection: DockerConnectionInfo;
  /** 当前 Tab 是否处于激活态；激活时自动拉取镜像列表。 */
  isActive?: boolean;
}

type SortColumn = "name" | "size" | "created" | "containers";
type SortDirection = "asc" | "desc";

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

async function fetchImages(connectionId: string): Promise<DockerImageSummary[]> {
  return unwrapCommand(commands.dockerListImages(connectionId));
}

async function fetchContainers(connectionId: string): Promise<DockerContainerSummary[]> {
  return unwrapCommand(commands.dockerListContainers(connectionId, null));
}

function formatCreatedAt(ts: number | null): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return "—";
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return new Date(ms).toLocaleString();
}

function compareImages(
  a: DockerImageSummary,
  b: DockerImageSummary,
  column: SortColumn,
  direction: SortDirection,
  containerIndex: Map<string, DockerContainerSummary[]>,
): number {
  let cmp = 0;
  switch (column) {
    case "name":
      cmp = imageRowLabel(a).localeCompare(imageRowLabel(b), undefined, {
        sensitivity: "base",
        numeric: true,
      });
      break;
    case "size":
      cmp = (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0);
      break;
    case "created":
      cmp = (a.createdAt ?? 0) - (b.createdAt ?? 0);
      break;
    case "containers":
      cmp = containersForImage(a, containerIndex).length - containersForImage(b, containerIndex).length;
      break;
  }
  return direction === "asc" ? cmp : -cmp;
}

function ImageContainerTags({ containers }: { containers: DockerContainerSummary[] }) {
  if (containers.length === 0) {
    return <span className="docker-image-panel__container-tags-empty">—</span>;
  }

  return (
    <span className="docker-image-panel__container-tags">
      {containers.map((container) => {
        const label = containerRowLabel(container);
        return (
          <span
            key={container.id}
            className={`tag docker-image-panel__container-tag${
              container.running ? " docker-image-panel__container-tag--running" : ""
            }`}
            title={label}
          >
            {label}
          </span>
        );
      })}
    </span>
  );
}

export function DockerImagePanel({ connection, isActive = false }: DockerImagePanelProps) {
  const { t } = useI18n();
  const [images, setImages] = useState<DockerImageSummary[]>(
    () => peekDockerSidebarCache(connection.connectionId).images,
  );
  const [containers, setContainers] = useState<DockerContainerSummary[]>(
    () => peekDockerSidebarCache(connection.connectionId).containers,
  );
  const [loading, setLoading] = useState(
    () => peekDockerSidebarCache(connection.connectionId).images.length === 0,
  );
  const [error, setError] = useState<string | null>(
    () => peekDockerSidebarCache(connection.connectionId).error,
  );
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ column: "name", direction: "asc" });
  const [pullOpen, setPullOpen] = useState(false);

  const refreshSidebarImages = useCallback(() => {
    void useDockerSidebarCacheStore
      .getState()
      .refreshScope({ kind: "category", connectionId: connection.connectionId, category: "images" });
    void useDockerSidebarCacheStore
      .getState()
      .refreshScope({ kind: "category", connectionId: connection.connectionId, category: "containers" });
  }, [connection.connectionId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextImages, nextContainers] = await Promise.all([
        fetchImages(connection.connectionId),
        fetchContainers(connection.connectionId),
      ]);
      startTransition(() => {
        setImages(nextImages);
        setContainers(nextContainers);
      });
      refreshSidebarImages();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [connection.connectionId, refreshSidebarImages]);

  useEffect(() => {
    // cache-first：切换连接时先灌入侧栏缓存，再由 isActive 触发后台 refresh，禁止同步清空
    const cached = peekDockerSidebarCache(connection.connectionId);
    startTransition(() => {
      setImages(cached.images);
      setContainers(cached.containers);
      setError(cached.error);
      setSearch("");
    });
  }, [connection.connectionId]);

  useEffect(() => {
    if (!isActive) return;
    void refresh();
  }, [isActive, refresh]);

  const toggleSort = useCallback((columnId: string) => {
    const column = columnId as SortColumn;
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" },
    );
  }, []);

  const containerIndex = useMemo(
    () => groupContainersByImageId(images, containers),
    [images, containers],
  );

  const filteredImages = useMemo(() => {
    const query = search.trim();
    if (!query) return images;
    return images.filter((image) => {
      if (dockerImageMatchesSearch(query, image)) return true;
      return containersForImage(image, containerIndex).some((container) =>
        dockerContainerMatchesSearch(query, container),
      );
    });
  }, [containerIndex, images, search]);

  const sortedImages = useMemo(() => {
    const sorted = [...filteredImages];
    sorted.sort((a, b) => compareImages(a, b, sort.column, sort.direction, containerIndex));
    return sorted;
  }, [containerIndex, filteredImages, sort.column, sort.direction]);

  /** 当前列表（含搜索过滤）的镜像大小合计，与 footer 计数口径一致。 */
  const totalSizeLabel = useMemo(() => {
    const totalBytes = sortedImages.reduce((sum, image) => sum + (image.sizeBytes ?? 0), 0);
    return formatBytes(totalBytes);
  }, [sortedImages]);

  const gridColumns = useMemo((): DbTablesPanelGridColumn<DockerImageSummary>[] => {
    return [
      {
        id: "name",
        sortId: "name",
        header: t("docker.imagesPanel.column.name"),
        sortable: true,
        nameCell: true,
        render: (image) => imageRowLabel(image),
        getTitle: (image) => imageRowLabel(image),
        getCopyValue: (image) => imageRowLabel(image),
      },
      {
        id: "id",
        header: t("docker.imagesPanel.column.id"),
        render: (image) => image.shortId || image.id.slice(0, 12) || "—",
        getTitle: (image) => image.id,
        getCopyValue: (image) => image.id,
      },
      {
        id: "size",
        sortId: "size",
        header: t("docker.imagesPanel.column.size"),
        sortable: true,
        render: (image) => imageRowSizeLabel(image),
        getTitle: (image) => imageRowSizeLabel(image),
        getCopyValue: (image) => imageRowSizeLabel(image),
      },
      {
        id: "created",
        sortId: "created",
        header: t("docker.imagesPanel.column.created"),
        sortable: true,
        render: (image) => formatCreatedAt(image.createdAt),
        getTitle: (image) => formatCreatedAt(image.createdAt),
      },
      {
        id: "containers",
        sortId: "containers",
        header: t("docker.imagesPanel.column.containers"),
        sortable: true,
        render: (image) => (
          <ImageContainerTags containers={containersForImage(image, containerIndex)} />
        ),
        getTitle: (image) => containerTagsCopyValue(containersForImage(image, containerIndex)),
        getCopyValue: (image) => containerTagsCopyValue(containersForImage(image, containerIndex)),
      },
      {
        id: "dangling",
        header: t("docker.imagesPanel.column.dangling"),
        render: (image) =>
          image.dangling
            ? t("docker.imagesPanel.danglingYes")
            : t("docker.imagesPanel.danglingNo"),
        getTitle: (image) =>
          image.dangling
            ? t("docker.imagesPanel.danglingYes")
            : t("docker.imagesPanel.danglingNo"),
      },
    ];
  }, [containerIndex, t]);

  const renderTable = () => {
    if (loading && images.length === 0) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (error && images.length === 0) {
      return <div className="db-tables-panel-error">{error}</div>;
    }
    if (images.length === 0) {
      return <div className="db-tables-panel-empty">{t("docker.imagesPanel.empty")}</div>;
    }
    if (sortedImages.length === 0) {
      return <div className="db-tables-panel-empty">{t("docker.imagesPanel.noResults")}</div>;
    }

    return (
      <DbTablesPanelGrid
        variant="variables"
        columns={gridColumns}
        rows={sortedImages}
        rowKey={(image, index) =>
          `${image.id}:${image.repository ?? ""}:${image.tag ?? ""}:${index}`
        }
        sortColumnId={sort.column}
        sortDirection={sort.direction}
        onSortColumn={toggleSort}
      />
    );
  };

  return (
    <ScopedSearch
      className="db-tables-panel db-tables-panel--dock docker-image-panel"
      value={search}
      onChange={setSearch}
      placeholder={t("docker.imagesPanel.search")}
      enabled
    >
      <div className="db-tables-panel-body">
        <div className="db-tables-panel-grid-wrap">{renderTable()}</div>
      </div>
      <div className="db-tables-panel-meta">
        <div className="docker-image-panel__meta-left">
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            title={t("docker.imagesPanel.pull")}
            aria-label={t("docker.imagesPanel.pull")}
            disabled={loading}
            onClick={() => setPullOpen(true)}
          >
            <DownloadIcon size={14} />
          </Button>
          <DbPanelMetaRefreshButton onClick={() => void refresh()} disabled={loading} busy={loading} />
          <span className="db-tables-panel-meta-text">
            {loading
              ? t("common.loading")
              : t("docker.imagesPanel.count", { count: sortedImages.length })}
          </span>
          {!loading && sortedImages.length > 0 ? (
            <span className="db-tables-panel-meta-text docker-image-panel__meta-size">
              {t("docker.imagesPanel.totalSize", { size: totalSizeLabel })}
            </span>
          ) : null}
        </div>
      </div>

      <DockerImagePullDialog
        open={pullOpen}
        connectionId={connection.connectionId}
        onClose={() => setPullOpen(false)}
        onPulled={() => void refresh()}
      />
    </ScopedSearch>
  );
}
