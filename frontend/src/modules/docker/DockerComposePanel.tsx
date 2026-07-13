import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { DockHandle, DockLayout, DockPanel } from "../../components/dock";
import { Button } from "../../components/ui/Button";
import { CodeEditor, codeEditorLanguageFromPath, type CodeEditorLanguage } from "../../components/ui/content/CodeEditor";
import { ModuleEmptyState } from "../../components/ui/feedback/ModuleEmptyState";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import type {
  DockerConnectionInfo,
  DockerContainerStats,
  DockerContainerSummary,
} from "../../ipc/bindings";
import {
  getComposeProjectMeta,
  peekComposeProjectMeta,
  readComposeProjectFiles,
  runComposeAction,
  writeComposeProjectFiles,
} from "./dockerComposeApi";
import { debugCompose } from "./dockerComposeDebug";
import { runDockerContainerAction } from "./dockerContainerActions";
import {
  getContainerLifecyclePhase,
  lifecycleStatusLabel,
  type DockerContainerLifecycleAction,
} from "./dockerContainerLifecycle";
import { containerRowLabel } from "./dockerResourceLabels";
import { useComposeProjectContainers } from "./hooks/useComposeProjectContainers";
import { PlayIcon, RestartIcon, StopIcon } from "./icons";

export interface DockerComposePanelProps {
  connection: DockerConnectionInfo;
  composeProject: string;
  isActive?: boolean;
}

const LOGS_POLL_MS = 5000;
const LOGS_INITIAL_DELAY_MS = 800;

function clampPercent(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function memoryHint(stats: DockerContainerStats | null): string | undefined {
  if (!stats) return undefined;
  const usage = formatBytes(stats.memoryUsageBytes);
  const limit = formatBytes(stats.memoryLimitBytes ?? undefined);
  if (!usage) return undefined;
  return limit ? `${usage} / ${limit}` : usage;
}

function ComposeMetricBar({
  label,
  value,
  hint,
  tone = "accent",
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: "accent" | "warn";
}) {
  const percent = clampPercent(value);
  return (
    <div className="docker-compose-panel__metric">
      <div className="docker-compose-panel__metric-head">
        <span>{label}</span>
        <span className="docker-compose-panel__metric-value">
          {percent.toFixed(1)}%
          {hint ? <span className="docker-compose-panel__metric-hint">{hint}</span> : null}
        </span>
      </div>
      <div className="docker-compose-panel__bar-track">
        <div
          className={`docker-compose-panel__bar-fill docker-compose-panel__bar-fill--${tone}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function ComposeContainerActions({
  phase,
  busy,
  onAction,
  t,
}: {
  phase: ReturnType<typeof getContainerLifecyclePhase>;
  busy: boolean;
  onAction: (action: DockerContainerLifecycleAction, event: MouseEvent<HTMLButtonElement>) => void;
  t: (key: string) => string;
}) {
  if (phase === "transitional" || busy) {
    return (
      <div className="docker-compose-panel__container-actions docker-compose-panel__container-actions--busy">
        <span className="docker-compose-panel__container-spinner" aria-hidden />
      </div>
    );
  }

  if (phase === "running") {
    return (
      <div className="docker-compose-panel__container-actions">
        <Button
          type="button"
          variant="icon"
          size="icon-xs"
          className="docker-compose-panel__container-action-btn"
          title={t("docker.dockPanel.stopContainer")}
          aria-label={t("docker.dockPanel.stopContainer")}
          onClick={(event) => onAction("stop", event)}
        >
          <StopIcon />
        </Button>
        <Button
          type="button"
          variant="icon"
          size="icon-xs"
          className="docker-compose-panel__container-action-btn"
          title={t("docker.dockPanel.restartContainer")}
          aria-label={t("docker.dockPanel.restartContainer")}
          onClick={(event) => onAction("restart", event)}
        >
          <RestartIcon />
        </Button>
      </div>
    );
  }

  return (
    <div className="docker-compose-panel__container-actions">
      <Button
        type="button"
        variant="icon"
        size="icon-xs"
        className="docker-compose-panel__container-action-btn docker-compose-panel__container-action-btn--start"
        title={t("docker.dockPanel.startContainer")}
        aria-label={t("docker.dockPanel.startContainer")}
        onClick={(event) => onAction("start", event)}
      >
        <PlayIcon />
      </Button>
    </div>
  );
}

function ComposeContainerRow({
  container,
  stats,
  busy,
  onAction,
  t,
}: {
  container: DockerContainerSummary;
  stats: DockerContainerStats | null;
  busy: boolean;
  onAction: (action: DockerContainerLifecycleAction, event: MouseEvent<HTMLButtonElement>) => void;
  t: (key: string) => string;
}) {
  const phase = getContainerLifecyclePhase(container, busy);
  const statusLabel = lifecycleStatusLabel(container, phase, t);
  const cpu = container.running ? (stats?.cpuPercent ?? 0) : 0;
  const memory = container.running ? (stats?.memoryPercent ?? 0) : 0;
  const name = container.composeService?.trim() || containerRowLabel(container);

  return (
    <article className={`docker-compose-panel__container-card docker-compose-panel__container-card--${phase}`}>
      <div className="docker-compose-panel__container-card-top">
        <div className="docker-compose-panel__container-identity">
          <span className="docker-compose-panel__container-name" title={name}>
            {name}
          </span>
          <span className="docker-compose-panel__container-image" title={container.image}>
            {container.image}
          </span>
        </div>
        <div className="docker-compose-panel__container-toolbar">
          <span
            className={`docker-compose-panel__container-status docker-compose-panel__container-status--${phase}`}
          >
            {statusLabel}
          </span>
          <ComposeContainerActions phase={phase} busy={busy} onAction={onAction} t={t} />
        </div>
      </div>
      {container.running ? (
        <div className="docker-compose-panel__container-metrics">
          <ComposeMetricBar label={t("docker.dockPanel.cpu")} value={cpu} />
          <ComposeMetricBar
            label={t("docker.dockPanel.memory")}
            value={memory}
            hint={memoryHint(stats)}
            tone={memory >= 85 ? "warn" : "accent"}
          />
        </div>
      ) : (
        <p className="docker-compose-panel__container-idle">{t("docker.composePanel.containerStoppedHint")}</p>
      )}
    </article>
  );
}

function EditorPane({
  title,
  pathHint,
  language,
  value,
  dirty,
  saving,
  readOnly,
  saveLabel,
  onChange,
  onSave,
}: {
  title: string;
  pathHint?: string;
  language?: CodeEditorLanguage;
  value: string;
  dirty: boolean;
  saving: boolean;
  readOnly?: boolean;
  saveLabel: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const resolvedLanguage =
    language ?? codeEditorLanguageFromPath(pathHint ?? "docker-compose.yml");

  return (
    <div className="docker-compose-panel__editor-pane">
      <div className="docker-compose-panel__editor-header">
        <div className="docker-compose-panel__editor-title">
          <span>{title}</span>
          {pathHint ? (
            <span className="docker-compose-panel__editor-path" title={pathHint}>
              {pathHint}
            </span>
          ) : null}
        </div>
        {!readOnly ? (
          <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
            {saveLabel}
          </Button>
        ) : null}
      </div>
      <div className="docker-compose-panel__editor-body">
        <CodeEditor
          value={value}
          onChange={onChange}
          language={resolvedLanguage}
          readOnly={readOnly}
          height="100%"
          className="docker-compose-panel__editor"
        />
      </div>
    </div>
  );
}

export function DockerComposePanel({
  connection,
  composeProject,
  isActive = false,
}: DockerComposePanelProps) {
  const { t } = useI18n();
  const cachedMeta = useMemo(
    () => peekComposeProjectMeta(connection.connectionId, composeProject),
    [connection.connectionId, composeProject],
  );
  const { items: projectContainers, loading, error, refreshNow } = useComposeProjectContainers(
    connection.connectionId,
    composeProject,
    isActive,
  );

  const [workingDir, setWorkingDir] = useState<string | null>(cachedMeta?.workingDir ?? null);
  const [configFile, setConfigFile] = useState<string | null>(
    cachedMeta?.configFiles?.split(",")[0]?.trim() || null,
  );
  const [composePath, setComposePath] = useState("");
  const [envPath, setEnvPath] = useState("");
  const [composeContent, setComposeContent] = useState("");
  const [envContent, setEnvContent] = useState("");
  const [savedComposeContent, setSavedComposeContent] = useState("");
  const [savedEnvContent, setSavedEnvContent] = useState("");
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesReadOnly, setFilesReadOnly] = useState(false);
  const [savingCompose, setSavingCompose] = useState(false);
  const [savingEnv, setSavingEnv] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [composeActionPending, setComposeActionPending] = useState<"restart" | "rebuild" | null>(
    null,
  );
  const [logsText, setLogsText] = useState("");
  const [logsError, setLogsError] = useState<string | null>(null);
  const [pendingContainerActions, setPendingContainerActions] = useState<Record<string, true>>({});
  const [metaReady, setMetaReady] = useState(Boolean(cachedMeta?.workingDir));

  const composeDirty = composeContent !== savedComposeContent;
  const envDirty = envContent !== savedEnvContent;

  const loadProjectMeta = useCallback(async () => {
    const meta = await getComposeProjectMeta(connection.connectionId, composeProject);
    debugCompose("loadProjectMeta", {
      composeProject,
      meta: meta
        ? {
            workingDir: meta.workingDir,
            configFiles: meta.configFiles,
          }
        : null,
    });
    setWorkingDir(meta?.workingDir ?? null);
    const config = meta?.configFiles?.split(",")[0]?.trim();
    setConfigFile(config || null);
    setMetaReady(Boolean(meta?.workingDir));
    return meta;
  }, [connection.connectionId, composeProject]);

  const loadFiles = useCallback(async () => {
    setFilesError(null);
    const hasContent = composeContent.length > 0 || envContent.length > 0;
    if (!hasContent) {
      setFilesLoading(true);
    }
    try {
      const meta = await loadProjectMeta();
      const readRequest = {
        project: composeProject,
        workingDir: meta?.workingDir ?? null,
        configFile: meta?.configFiles?.split(",")[0]?.trim() || null,
      };
      debugCompose("loadFiles 开始", readRequest);
      const files = await readComposeProjectFiles(connection.connectionId, readRequest);
      debugCompose("loadFiles 完成", {
        composePath: files.composePath,
        envPath: files.envPath,
        composeBytes: files.composeContent.length,
        envBytes: files.envContent.length,
      });
      setComposePath(files.composePath);
      setEnvPath(files.envPath);
      setComposeContent(files.composeContent);
      setEnvContent(files.envContent);
      setSavedComposeContent(files.composeContent);
      setSavedEnvContent(files.envContent);
      setFilesReadOnly(false);
    } catch (e) {
      debugCompose("loadFiles 失败", { error: String(e) });
      setFilesError(String(e));
      setFilesReadOnly(true);
      setMetaReady(true);
    } finally {
      setFilesLoading(false);
    }
  }, [
    composeContent.length,
    composeProject,
    connection.connectionId,
    envContent.length,
    loadProjectMeta,
  ]);

  useEffect(() => {
    if (!isActive) return;
    void loadFiles();
  }, [isActive, loadFiles]);

  const showSaveToast = useCallback((message: string) => {
    setSaveMessage(message);
    window.setTimeout(() => setSaveMessage(null), 2400);
  }, []);

  const showActionToast = useCallback((message: string) => {
    setActionMessage(message);
    window.setTimeout(() => setActionMessage(null), 3200);
  }, []);

  const composeActionRequest = useMemo(
    () => ({
      project: composeProject,
      workingDir,
      configFile,
      services: [] as string[],
      detached: true,
    }),
    [composeProject, configFile, workingDir],
  );

  const handleContainerLifecycle = useCallback(
    (container: DockerContainerSummary, action: DockerContainerLifecycleAction, event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      void (async () => {
        setActionError(null);
        setPendingContainerActions((current) => ({ ...current, [container.id]: true }));
        try {
          await runDockerContainerAction(connection.connectionId, container.id, action);
          refreshNow();
        } catch (e) {
          setActionError(String(e));
        } finally {
          setPendingContainerActions((current) => {
            const next = { ...current };
            delete next[container.id];
            return next;
          });
        }
      })();
    },
    [connection.connectionId, refreshNow],
  );

  const handleComposeLifecycle = useCallback(
    (action: "restart" | "rebuild") => {
      void (async () => {
        if (action === "rebuild") {
          const confirmed = await appConfirm(
            t("docker.composePanel.rebuildConfirm", { project: composeProject }),
          );
          if (!confirmed) return;
        }
        setActionError(null);
        setComposeActionPending(action);
        try {
          const result = await runComposeAction(connection.connectionId, action, composeActionRequest);
          if (result.exitCode !== 0) {
            const detail = [result.stderrExcerpt, result.stdoutExcerpt].filter(Boolean).join("\n");
            throw new Error(detail || t("docker.composePanel.actionFailed"));
          }
          showActionToast(
            action === "restart"
              ? t("docker.composePanel.restarted")
              : t("docker.composePanel.rebuilt"),
          );
          refreshNow();
        } catch (e) {
          setActionError(String(e));
        } finally {
          setComposeActionPending(null);
        }
      })();
    },
    [
      composeActionRequest,
      composeProject,
      connection.connectionId,
      refreshNow,
      showActionToast,
      t,
    ],
  );

  const handleSaveCompose = useCallback(async () => {
    setSavingCompose(true);
    setFilesError(null);
    try {
      await writeComposeProjectFiles(connection.connectionId, {
        project: composeProject,
        workingDir,
        configFile,
        composePath: composePath || null,
        composeContent,
        envPath: null,
        envContent: null,
      });
      setSavedComposeContent(composeContent);
      showSaveToast(t("docker.composePanel.savedCompose"));
    } catch (e) {
      setFilesError(String(e));
    } finally {
      setSavingCompose(false);
    }
  }, [
    composeContent,
    composePath,
    composeProject,
    configFile,
    connection.connectionId,
    showSaveToast,
    t,
    workingDir,
  ]);

  const handleSaveEnv = useCallback(async () => {
    setSavingEnv(true);
    setFilesError(null);
    try {
      await writeComposeProjectFiles(connection.connectionId, {
        project: composeProject,
        workingDir,
        configFile,
        composePath: null,
        composeContent: null,
        envPath: envPath || null,
        envContent,
      });
      setSavedEnvContent(envContent);
      showSaveToast(t("docker.composePanel.savedEnv"));
    } catch (e) {
      setFilesError(String(e));
    } finally {
      setSavingEnv(false);
    }
  }, [
    configFile,
    connection.connectionId,
    composeProject,
    envContent,
    envPath,
    showSaveToast,
    t,
    workingDir,
  ]);

  const logsRequestRef = useRef({
    project: composeProject,
    workingDir,
    configFile,
  });
  logsRequestRef.current = { project: composeProject, workingDir, configFile };

  useEffect(() => {
    if (!isActive || !metaReady) {
      setLogsText("");
      setLogsError(null);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const refreshLogs = async () => {
      const { project, workingDir: wd, configFile: cf } = logsRequestRef.current;
      try {
        const result = await runComposeAction(connection.connectionId, "logs", {
          project,
          workingDir: wd,
          configFile: cf,
          services: [],
          detached: false,
        });
        if (cancelled) return;
        const chunks = [result.stdoutExcerpt, result.stderrExcerpt].filter(Boolean);
        setLogsText(chunks.join(chunks.length > 1 ? "\n" : ""));
        setLogsError(result.exitCode !== 0 && !chunks.length ? t("docker.composePanel.logsFailed") : null);
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
  }, [connection.connectionId, isActive, metaReady, t]);

  if (!isActive) {
    return <div className="docker-compose-panel docker-compose-panel--inactive" aria-hidden />;
  }

  return (
    <div className="docker-compose-panel">
      <div className="docker-compose-panel__header">
        <div>
          <h2 className="docker-compose-panel__title">{composeProject}</h2>
          <p className="docker-compose-panel__subtitle">
            {connection.name}
            {connection.hostLabel ? ` · ${connection.hostLabel}` : ""}
            {workingDir ? ` · ${workingDir}` : ""}
          </p>
        </div>
        <div className="docker-compose-panel__header-actions">
          <Button
            size="sm"
            variant="secondary"
            disabled={composeActionPending != null}
            onClick={() => handleComposeLifecycle("restart")}
          >
            {composeActionPending === "restart"
              ? t("docker.composePanel.restarting")
              : t("docker.composePanel.restart")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={composeActionPending != null}
            onClick={() => handleComposeLifecycle("rebuild")}
          >
            {composeActionPending === "rebuild"
              ? t("docker.composePanel.rebuilding")
              : t("docker.composePanel.rebuild")}
          </Button>
          {saveMessage ? <span className="docker-compose-panel__toast">{saveMessage}</span> : null}
          {actionMessage ? <span className="docker-compose-panel__toast">{actionMessage}</span> : null}
        </div>
      </div>

      {error || filesError || actionError ? (
        <div className="docker-compose-panel__error">{error ?? filesError ?? actionError}</div>
      ) : null}

      <div className="docker-compose-panel__body">
        <DockLayout direction="horizontal" className="docker-compose-panel__split">
          <DockPanel defaultSize="20%" minSize="14%" maxSize="35%" className="docker-compose-panel__list-pane">
            <div className="docker-compose-panel__list-wrap">
              <div className="docker-compose-panel__list-header">
                <span>{t("docker.composePanel.containers")}</span>
                <span className="docker-compose-panel__list-count">{projectContainers.length}</span>
              </div>
              <div className="docker-compose-panel__list-body">
                {loading && projectContainers.length === 0 ? (
                  <div className="docker-compose-panel__list-loading">{t("docker.dockPanel.loading")}</div>
                ) : projectContainers.length === 0 ? (
                  <ModuleEmptyState preset="container" title={t("docker.composePanel.noContainers")} />
                ) : (
                  projectContainers.map(({ container, stats }) => (
                    <ComposeContainerRow
                      key={container.id}
                      container={container}
                      stats={stats}
                      busy={Boolean(pendingContainerActions[container.id])}
                      onAction={(action, event) => handleContainerLifecycle(container, action, event)}
                      t={t}
                    />
                  ))
                )}
              </div>
            </div>
          </DockPanel>
          <DockHandle direction="horizontal" />
          <DockPanel defaultSize="80%" minSize="55%" className="docker-compose-panel__main-pane">
            <DockLayout direction="vertical" className="docker-compose-panel__main-split">
              <DockPanel defaultSize="62%" minSize="35%" className="docker-compose-panel__editors-pane">
                <DockLayout direction="horizontal" className="docker-compose-panel__editors-split">
                  <DockPanel defaultSize="50%" minSize="30%" className="docker-compose-panel__compose-editor-pane">
                    {filesLoading && !composeContent ? (
                      <div className="docker-compose-panel__files-loading">{t("docker.composePanel.loadingFiles")}</div>
                    ) : (
                      <EditorPane
                        title={t("docker.composePanel.composeFile")}
                        pathHint={composePath || undefined}
                        language="yaml"
                        value={composeContent}
                        dirty={composeDirty}
                        saving={savingCompose}
                        readOnly={filesReadOnly}
                        saveLabel={t("docker.composePanel.save")}
                        onChange={setComposeContent}
                        onSave={() => void handleSaveCompose()}
                      />
                    )}
                  </DockPanel>
                  <DockHandle direction="horizontal" />
                  <DockPanel defaultSize="50%" minSize="30%" className="docker-compose-panel__env-editor-pane">
                    {filesLoading && !envContent ? (
                      <div className="docker-compose-panel__files-loading">{t("docker.composePanel.loadingFiles")}</div>
                    ) : (
                      <EditorPane
                        title={t("docker.composePanel.envFile")}
                        pathHint={envPath || undefined}
                        language="ini"
                        value={envContent}
                        dirty={envDirty}
                        saving={savingEnv}
                        readOnly={filesReadOnly}
                        saveLabel={t("docker.composePanel.save")}
                        onChange={setEnvContent}
                        onSave={() => void handleSaveEnv()}
                      />
                    )}
                  </DockPanel>
                </DockLayout>
              </DockPanel>
              <DockHandle direction="vertical" />
              <DockPanel defaultSize="38%" minSize="18%" className="docker-compose-panel__logs-pane">
                <div className="docker-compose-panel__logs-wrap">
                  <div className="docker-compose-panel__logs-header">{t("docker.composePanel.logs")}</div>
                  <div className="docker-compose-panel__logs-body">
                    {logsError ? (
                      <div className="docker-compose-panel__logs-error">{logsError}</div>
                    ) : null}
                    <pre className="docker-compose-panel__logs-content">
                      {logsText || t("docker.dockPanel.subwindowEmptyLogs")}
                    </pre>
                  </div>
                </div>
              </DockPanel>
            </DockLayout>
          </DockPanel>
        </DockLayout>
      </div>
    </div>
  );
}
