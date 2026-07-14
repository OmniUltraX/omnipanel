import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import { selectDockerSidebarCacheEntry } from "./dockerSidebarCache";
import { resolveComposeProjectName } from "./dockerComposeGroups";
import { runComposeAction } from "./dockerComposeApi";
import {
  composeLogServiceKey,
  resolveComposeLogServices,
} from "./dockerComposePanelCache";
import { FollowIcon, TrashIcon } from "./icons";
import { useDockerSidebarCacheStore } from "../../stores/dockerSidebarCacheStore";

const LOGS_POLL_MS = 8000;
const LOGS_INITIAL_DELAY_MS = 800;

export type DockerComposeLogsColumnProps = {
  connectionId: string;
  composeProject: string;
  isActive: boolean;
  metaReady: boolean;
  workingDir: string | null;
  configFile: string | null;
  logEnabledByService: Record<string, boolean>;
  initialLogsText?: string;
  onLogsTextChange?: (text: string) => void;
};

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** 日志列：只订侧栏容器身份（不含 stats），避免与 CPU/内存轮询耦合。 */
export function DockerComposeLogsColumn({
  connectionId,
  composeProject,
  isActive,
  metaReady,
  workingDir,
  configFile,
  logEnabledByService,
  initialLogsText = "",
  onLogsTextChange,
}: DockerComposeLogsColumnProps) {
  const { t } = useI18n();
  const projectKey = composeProject.trim();
  const sidebarEntry = useDockerSidebarCacheStore(
    useCallback(selectDockerSidebarCacheEntry(connectionId), [connectionId]),
  );

  const logServiceKeysSig = useMemo(() => {
    const keys = Array.from(
      new Set(
        sidebarEntry.containers
          .filter((container) => resolveComposeProjectName(container) === projectKey)
          .map((container) => composeLogServiceKey(container)),
      ),
    ).sort();
    return keys.join("\0");
  }, [projectKey, sidebarEntry.containers]);

  const logServiceKeys = useMemo(
    () => (logServiceKeysSig ? logServiceKeysSig.split("\0") : []),
    [logServiceKeysSig],
  );

  const logsServices = useMemo(
    () => resolveComposeLogServices(logServiceKeys, logEnabledByService),
    [logEnabledByService, logServiceKeys],
  );

  const logsServicesSig =
    logsServices == null ? null : logsServices.length === 0 ? "" : logsServices.join("\0");

  const [logsText, setLogsText] = useState(initialLogsText);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsFollowing, setLogsFollowing] = useState(true);
  const [pageVisible, setPageVisible] = useState(documentVisible);
  const logsBodyRef = useRef<HTMLDivElement | null>(null);
  const logsRequestRef = useRef({
    project: composeProject,
    workingDir,
    configFile,
    services: logsServices as string[] | null,
  });
  logsRequestRef.current = {
    project: composeProject,
    workingDir,
    configFile,
    services: logsServices,
  };

  useEffect(() => {
    const onVisibility = () => setPageVisible(documentVisible());
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const onLogsTextChangeRef = useRef(onLogsTextChange);
  onLogsTextChangeRef.current = onLogsTextChange;

  // 禁止在 setState updater 内回调父组件（会触发 "update while rendering"）
  const applyLogsText = useCallback((next: string) => {
    setLogsText((prev) => (prev === next ? prev : next));
  }, []);

  useEffect(() => {
    onLogsTextChangeRef.current?.(logsText);
  }, [logsText]);

  useEffect(() => {
    if (!isActive || !metaReady || !pageVisible) {
      return;
    }

    if (logsServicesSig == null) {
      applyLogsText("");
      setLogsError(null);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const refreshLogs = async () => {
      if (!documentVisible()) return;
      const { project, workingDir: wd, configFile: cf, services } = logsRequestRef.current;
      if (services == null) return;
      try {
        const result = await runComposeAction(connectionId, "logs", {
          project,
          workingDir: wd,
          configFile: cf,
          services,
          detached: false,
        });
        if (cancelled) return;
        const chunks = [result.stdoutExcerpt, result.stderrExcerpt].filter(Boolean);
        applyLogsText(chunks.join(chunks.length > 1 ? "\n" : ""));
        setLogsError(
          result.exitCode !== 0 && !chunks.length ? t("docker.composePanel.logsFailed") : null,
        );
      } catch (e) {
        if (!cancelled) {
          setLogsError(String(e));
        }
      }
    };

    const initialTimer = window.setTimeout(() => {
      void refreshLogs();
      timer = window.setInterval(() => void refreshLogs(), LOGS_POLL_MS);
    }, LOGS_INITIAL_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      if (timer != null) window.clearInterval(timer);
    };
  }, [
    applyLogsText,
    connectionId,
    isActive,
    logsServicesSig,
    metaReady,
    pageVisible,
    t,
  ]);

  useEffect(() => {
    if (!logsFollowing) return;
    const el = logsBodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logsFollowing, logsText]);

  const handleClearLogs = useCallback(() => {
    applyLogsText("");
    setLogsError(null);
  }, [applyLogsText]);

  return (
    <div className="docker-compose-panel__logs-wrap">
      <div className="docker-compose-panel__logs-header">
        <span>{t("docker.composePanel.logs")}</span>
        <div className="docker-compose-panel__logs-header-actions">
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            className={`docker-compose-panel__logs-action${logsFollowing ? " is-active" : ""}`}
            title={
              logsFollowing
                ? t("docker.composePanel.logsStopFollow")
                : t("docker.composePanel.logsFollow")
            }
            aria-label={
              logsFollowing
                ? t("docker.composePanel.logsStopFollow")
                : t("docker.composePanel.logsFollow")
            }
            aria-pressed={logsFollowing}
            onClick={() => setLogsFollowing((v) => !v)}
          >
            <FollowIcon active={logsFollowing} />
          </Button>
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            className="docker-compose-panel__logs-action"
            title={t("docker.composePanel.logsClear")}
            aria-label={t("docker.composePanel.logsClear")}
            onClick={handleClearLogs}
            disabled={!logsText && !logsError}
          >
            <TrashIcon />
          </Button>
        </div>
      </div>
      <div ref={logsBodyRef} className="docker-compose-panel__logs-body">
        {logsError ? <div className="docker-compose-panel__logs-error">{logsError}</div> : null}
        <pre className="docker-compose-panel__logs-content">
          {logsServices == null
            ? t("docker.composePanel.logsNoneSelected")
            : logsText || t("docker.dockPanel.subwindowEmptyLogs")}
        </pre>
      </div>
    </div>
  );
}
