import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { DockHandle, DockLayout, DockPanel } from "../../components/dock";
import { SftpPanel } from "../../components/sftp";
import { Button } from "../../components/ui/Button";
import { IconPlus } from "../../components/ui/Icons";
import { ModuleEmptyState } from "../../components/ui/feedback/ModuleEmptyState";
import { FormDialog, FormField } from "../../components/ui/form/FormDialog";
import { TextInput } from "../../components/ui/form/TextInput";
import { ScopedSearch } from "../../components/ui/search/ScopedSearch";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import type { DockerConnectionInfo, DockerVolumeSummary } from "../../ipc/bindings";
import { unwrapCommand, unwrapCommandResult } from "../../ipc/result";
import { appConfirm } from "../../lib/appConfirm";
import { showToast } from "../../stores/toastStore";
import { useDockerSidebarCacheStore } from "../../stores/dockerSidebarCacheStore";
import { DbPanelMetaRefreshButton } from "../database/workspace/DbPanelMetaRefreshButton";
import { peekDockerSidebarCache } from "./dockerSidebarCacheSeed";
import { dockerVolumeMatchesSearch } from "./dockerTreeSearch";
import { volumeRowLabel } from "./dockerResourceLabels";
import { makeDockerVolumeSftpAdapter } from "./dockerVolumeSftpAdapter";
import { TrashIcon } from "./icons";

export interface DockerVolumePanelProps {
  connection: DockerConnectionInfo;
  isActive?: boolean;
}

async function fetchVolumes(connectionId: string): Promise<DockerVolumeSummary[]> {
  return unwrapCommandResult(await commands.dockerListVolumes(connectionId));
}

export function DockerVolumePanel({ connection, isActive = false }: DockerVolumePanelProps) {
  const { t } = useI18n();
  const [volumes, setVolumes] = useState<DockerVolumeSummary[]>(
    () => peekDockerSidebarCache(connection.connectionId).volumes,
  );
  const [selectedVolumeName, setSelectedVolumeName] = useState<string | null>(
    () => peekDockerSidebarCache(connection.connectionId).volumes[0]?.name ?? null,
  );
  const [loading, setLoading] = useState(
    () => peekDockerSidebarCache(connection.connectionId).volumes.length === 0,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    () => peekDockerSidebarCache(connection.connectionId).error,
  );
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const refreshSidebarVolumes = useCallback(() => {
    void useDockerSidebarCacheStore
      .getState()
      .refreshScope({ kind: "category", connectionId: connection.connectionId, category: "volumes" });
  }, [connection.connectionId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchVolumes(connection.connectionId);
      startTransition(() => {
        setVolumes(next);
        setSelectedVolumeName((current) => {
          if (current && next.some((volume) => volume.name === current)) {
            return current;
          }
          return next[0]?.name ?? null;
        });
      });
      refreshSidebarVolumes();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [connection.connectionId, refreshSidebarVolumes]);

  useEffect(() => {
    const cached = peekDockerSidebarCache(connection.connectionId);
    startTransition(() => {
      setVolumes(cached.volumes);
      setSelectedVolumeName(cached.volumes[0]?.name ?? null);
      setError(cached.error);
      setSearch("");
    });
  }, [connection.connectionId]);

  useEffect(() => {
    if (!isActive) return;
    void refresh();
  }, [isActive, refresh]);

  const filteredVolumes = useMemo(() => {
    const query = search.trim();
    if (!query) return volumes;
    return volumes.filter((volume) => dockerVolumeMatchesSearch(query, volume));
  }, [search, volumes]);

  const selectedVolume = useMemo(
    () => volumes.find((volume) => volume.name === selectedVolumeName) ?? null,
    [selectedVolumeName, volumes],
  );

  const adapter = useMemo(() => {
    if (!selectedVolumeName) return null;
    return makeDockerVolumeSftpAdapter(
      connection.connectionId,
      selectedVolumeName,
      connection.source,
    );
  }, [connection.connectionId, connection.source, selectedVolumeName]);

  const handlePrune = useCallback(() => {
    void (async () => {
      const confirmed = await appConfirm(
        t("docker.volumesPanel.pruneConfirm"),
        t("docker.volumesPanel.prune"),
        { kind: "warning", confirmLabel: t("docker.volumesPanel.prune") },
      );
      if (!confirmed) return;
      setBusy(true);
      try {
        const pruned = await unwrapCommand(commands.dockerPruneVolumes(connection.connectionId));
        showToast(
          t("docker.volumesPanel.pruneSuccess", {
            count: pruned.deleted?.length ?? 0,
          }),
        );
        await refresh();
      } catch (err) {
        showToast(`${t("docker.volumesPanel.pruneFailed")}: ${String(err)}`);
      } finally {
        setBusy(false);
      }
    })();
  }, [connection.connectionId, refresh, t]);

  const handleCreate = useCallback(() => {
    const name = createName.trim();
    if (!name) {
      setCreateError(t("docker.volumesPanel.createNameRequired"));
      return;
    }
    void (async () => {
      setBusy(true);
      setCreateError(null);
      try {
        await unwrapCommand(
          commands.dockerCreateVolume(connection.connectionId, {
            name,
            driver: null,
            labels: [],
          }),
        );
        showToast(t("docker.volumesPanel.createSuccess", { name }));
        setCreateOpen(false);
        setCreateName("");
        await refresh();
        setSelectedVolumeName(name);
      } catch (err) {
        setCreateError(String(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [connection.connectionId, createName, refresh, t]);

  if (!isActive) {
    return <div className="docker-volume-panel docker-volume-panel--inactive" aria-hidden />;
  }

  return (
    <ScopedSearch
      className="docker-volume-panel"
      value={search}
      onChange={setSearch}
      placeholder={t("docker.volumesPanel.search")}
      enabled
    >
      <div className="docker-volume-panel__header">
        <h2 className="docker-volume-panel__title">{t("docker.tabs.volumes")}</h2>
        <p className="docker-volume-panel__subtitle">
          {connection.name}
          {connection.hostLabel ? ` · ${connection.hostLabel}` : ""}
          {selectedVolume?.mountpoint ? ` · ${selectedVolume.mountpoint}` : ""}
        </p>
      </div>

      {error ? <div className="docker-volume-panel__error">{error}</div> : null}

      <div className="docker-volume-panel__body">
        <DockLayout direction="horizontal" className="docker-volume-panel__split">
          <DockPanel defaultSize="22%" minSize="16%" maxSize="35%" className="docker-volume-panel__list-pane">
            <div className="docker-volume-panel__list-wrap">
              <div className="docker-volume-panel__list-header">
                <div className="docker-volume-panel__list-header-left">
                  <Button
                    type="button"
                    variant="icon"
                    size="icon-xs"
                    title={t("docker.volumesPanel.prune")}
                    aria-label={t("docker.volumesPanel.prune")}
                    disabled={loading || busy}
                    onClick={handlePrune}
                  >
                    <TrashIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="icon"
                    size="icon-xs"
                    title={t("docker.volumesPanel.create")}
                    aria-label={t("docker.volumesPanel.create")}
                    disabled={loading || busy}
                    onClick={() => {
                      setCreateError(null);
                      setCreateName("");
                      setCreateOpen(true);
                    }}
                  >
                    <IconPlus size={14} />
                  </Button>
                  <span>{t("docker.volumesPanel.volumeList")}</span>
                </div>
                <span className="docker-volume-panel__list-count">{filteredVolumes.length}</span>
              </div>
              <div className="docker-volume-panel__list-body">
                {loading && volumes.length === 0 ? (
                  <div className="docker-volume-panel__list-loading">{t("common.loading")}</div>
                ) : volumes.length === 0 ? (
                  <ModuleEmptyState preset="volume" title={t("docker.volumesPanel.empty")} />
                ) : filteredVolumes.length === 0 ? (
                  <div className="docker-volume-panel__list-empty">{t("docker.volumesPanel.noResults")}</div>
                ) : (
                  filteredVolumes.map((volume) => {
                    const active = volume.name === selectedVolumeName;
                    return (
                      <button
                        key={volume.name}
                        type="button"
                        className={`docker-volume-panel__volume-item${active ? " docker-volume-panel__volume-item--active" : ""}`}
                        onClick={() => setSelectedVolumeName(volume.name)}
                        title={volume.mountpoint || volume.name}
                      >
                        <span className="docker-volume-panel__volume-name">{volumeRowLabel(volume)}</span>
                        <span className="docker-volume-panel__volume-meta">
                          {volume.driver || "—"}
                          {volume.inUse ? ` · ${t("docker.volumesPanel.inUse")}` : ""}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </DockPanel>
          <DockHandle direction="horizontal" />
          <DockPanel defaultSize="78%" minSize="55%" className="docker-volume-panel__browser-pane">
            <div className="docker-volume-panel__browser-wrap">
              {selectedVolume && adapter ? (
                <div className="docker-volume-panel__sftp-wrap" key={selectedVolume.name}>
                  <SftpPanel
                    resourceId={null}
                    adapter={adapter}
                    cacheKey={`${connection.connectionId}:${selectedVolume.name}`}
                  />
                </div>
              ) : (
                <ModuleEmptyState
                  preset="volume"
                  title={t("docker.volumesPanel.selectVolume")}
                />
              )}
            </div>
          </DockPanel>
        </DockLayout>
      </div>

      <div className="docker-volume-panel__meta">
        <DbPanelMetaRefreshButton onClick={() => void refresh()} disabled={loading || busy} busy={loading} />
        <span className="docker-volume-panel__meta-text">
          {loading
            ? t("common.loading")
            : t("docker.volumesPanel.count", { count: filteredVolumes.length })}
        </span>
      </div>

      <FormDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("docker.volumesPanel.create")}
        size="sm"
        clipboardAssist={false}
        cancelDisabled={busy}
        closeDisabled={busy}
        primaryAction={{
          label: busy ? t("common.saving") : t("common.confirm"),
          disabled: busy || !createName.trim(),
          onClick: handleCreate,
        }}
        status={createError ? { kind: "error", message: createError } : null}
      >
        <FormField label={t("docker.volumesPanel.createName")}>
          <TextInput
            value={createName}
            onChange={setCreateName}
            placeholder={t("docker.volumesPanel.createNamePlaceholder")}
            disabled={busy}
          />
        </FormField>
      </FormDialog>
    </ScopedSearch>
  );
}
