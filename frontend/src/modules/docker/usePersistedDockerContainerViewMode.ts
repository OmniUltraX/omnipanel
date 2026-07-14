import { useCallback, useState } from "react";

export type DockerContainerViewMode = "grid" | "table";

const STORAGE_KEY = "omnipanel-docker-container-view-mode.v1";
const DEFAULT_MODE: DockerContainerViewMode = "grid";

function readMode(): DockerContainerViewMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "table" || raw === "grid") return raw;
  } catch {
    // ignore quota / privacy mode
  }
  return DEFAULT_MODE;
}

function writeMode(mode: DockerContainerViewMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

/** 容器列表显示方式：默认网格，偏好写入 localStorage。 */
export function usePersistedDockerContainerViewMode() {
  const [viewMode, setViewModeState] = useState<DockerContainerViewMode>(readMode);

  const setViewMode = useCallback((mode: DockerContainerViewMode) => {
    setViewModeState(mode);
    writeMode(mode);
  }, []);

  return { viewMode, setViewMode };
}
