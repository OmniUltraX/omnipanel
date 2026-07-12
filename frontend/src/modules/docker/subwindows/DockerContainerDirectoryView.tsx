import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { useI18n } from "../../../i18n";
import type { DockerFileEntry } from "../../../ipc/bindings";
import { formatFileSize, formatOctalMode, listDockerContainerDir } from "./dockerContainerApi";

interface DockerContainerDirectoryViewProps {
  connectionId: string;
  containerId: string;
}

function parentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "/";
  return normalized.slice(0, idx);
}

function entryTypeLabel(entry: DockerFileEntry, t: (key: string) => string): string {
  if (entry.isDir) return t("docker.dockPanel.subwindowTypeDir");
  if (entry.isSymlink) return t("docker.dockPanel.subwindowTypeLink");
  return t("docker.dockPanel.subwindowTypeFile");
}

export function DockerContainerDirectoryView({ connectionId, containerId }: DockerContainerDirectoryViewProps) {
  const { t } = useI18n();
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<DockerFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDirectory = useCallback(
    async (path: string) => {
      setLoading(true);
      try {
        const data = await listDockerContainerDir(connectionId, containerId, path);
        setEntries(data);
        setError(null);
      } catch (e) {
        setEntries([]);
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [connectionId, containerId],
  );

  useEffect(() => {
    void loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  const canGoUp = currentPath !== "/";
  const pathSegments = useMemo(() => {
    if (currentPath === "/") return ["/"];
    const parts = currentPath.split("/").filter(Boolean);
    const segments: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      segments.push(`/${parts.slice(0, i + 1).join("/")}`);
    }
    return segments;
  }, [currentPath]);

  const openEntry = (entry: DockerFileEntry) => {
    if (!entry.isDir) return;
    setCurrentPath(entry.path || `${currentPath.replace(/\/+$/, "")}/${entry.name}`);
  };

  return (
    <div className="docker-container-subwindow docker-container-subwindow--directory">
      <div className="docker-container-subwindow__dir-toolbar">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canGoUp || loading}
          onClick={() => setCurrentPath(parentPath(currentPath))}
        >
          {t("docker.dockPanel.subwindowParentDir")}
        </Button>
        <div className="docker-container-subwindow__breadcrumb" aria-label={currentPath}>
          {pathSegments.map((segment) => (
            <button
              key={segment}
              type="button"
              className="docker-container-subwindow__breadcrumb-item"
              onClick={() => setCurrentPath(segment)}
            >
              {segment === "/" ? "/" : segment.split("/").pop()}
            </button>
          ))}
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void loadDirectory(currentPath)}>
          {t("docker.dockPanel.subwindowRefresh")}
        </Button>
      </div>

      {error ? <div className="docker-container-subwindow__error">{error}</div> : null}
      {loading ? (
        <div className="docker-container-subwindow__state">{t("docker.dockPanel.subwindowLoading")}</div>
      ) : entries.length === 0 ? (
        <div className="docker-container-subwindow__state">{t("docker.dockPanel.subwindowEmptyDir")}</div>
      ) : (
        <div className="docker-container-subwindow__table-wrap">
          <table className="docker-container-subwindow__table docker-container-subwindow__table--dir">
            <thead>
              <tr>
                <th>{t("docker.dockPanel.subwindowColName")}</th>
                <th>{t("docker.dockPanel.subwindowColType")}</th>
                <th>{t("docker.dockPanel.subwindowColSize")}</th>
                <th>{t("docker.dockPanel.subwindowColMode")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={`${entry.path}:${entry.name}`}
                  className={entry.isDir ? "is-dir" : undefined}
                  onClick={() => openEntry(entry)}
                  onKeyDown={(event) => {
                    if (entry.isDir && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      openEntry(entry);
                    }
                  }}
                  tabIndex={entry.isDir ? 0 : -1}
                  role={entry.isDir ? "button" : undefined}
                >
                  <td title={entry.path}>{entry.name}</td>
                  <td>{entryTypeLabel(entry, t)}</td>
                  <td>{entry.isDir ? "—" : formatFileSize(entry.sizeBytes)}</td>
                  <td>{formatOctalMode(entry.mode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
