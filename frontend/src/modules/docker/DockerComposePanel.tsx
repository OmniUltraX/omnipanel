import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DockHandle, DockLayout, DockPanel } from "../../components/dock";
import { Button } from "../../components/ui/Button";
import { CodeEditor, codeEditorLanguageFromPath, type CodeEditorLanguage } from "../../components/ui/content/CodeEditor";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import type { DockerConnectionInfo } from "../../ipc/bindings";
import {
  getComposeProjectMeta,
  peekComposeProjectMeta,
  readComposeProjectFiles,
  runComposeAction,
  writeComposeProjectFiles,
} from "./dockerComposeApi";
import { debugCompose } from "./dockerComposeDebug";
import {
  peekComposePanelCache,
  seedComposePanelFromMeta,
  writeComposePanelCache,
} from "./dockerComposePanelCache";
import { DockerComposeContainersColumn } from "./DockerComposeContainersColumn";
import { DockerComposeLogsColumn } from "./DockerComposeLogsColumn";

export interface DockerComposePanelProps {
  connection: DockerConnectionInfo;
  composeProject: string;
  isActive?: boolean;
}

const EditorPane = memo(function EditorPane({
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
  readOnly: boolean;
  saveLabel: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="docker-compose-panel__editor-pane">
      <div className="docker-compose-panel__editor-header">
        <div className="docker-compose-panel__editor-title" title={pathHint || title}>
          <span>{title}</span>
          {pathHint ? (
            <span className="docker-compose-panel__editor-path">{pathHint}</span>
          ) : null}
        </div>
        <Button size="xs" variant="secondary" disabled={readOnly || !dirty || saving} onClick={onSave}>
          {saving ? "…" : saveLabel}
        </Button>
      </div>
      <div className="docker-compose-panel__editor-body">
        <CodeEditor
          className="docker-compose-panel__code-editor"
          value={value}
          language={language ?? codeEditorLanguageFromPath(pathHint ?? "")}
          readOnly={readOnly}
          onChange={onChange}
        />
      </div>
    </div>
  );
});

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
  const panelCache = useMemo(
    () => peekComposePanelCache(connection.connectionId, composeProject),
    [connection.connectionId, composeProject],
  );
  const seededMeta = useMemo(() => seedComposePanelFromMeta(cachedMeta), [cachedMeta]);

  const [workingDir, setWorkingDir] = useState<string | null>(
    panelCache?.workingDir ?? seededMeta.workingDir,
  );
  const [configFile, setConfigFile] = useState<string | null>(
    panelCache?.configFile ?? seededMeta.configFile,
  );
  const [composePath, setComposePath] = useState(panelCache?.composePath ?? "");
  const [envPath, setEnvPath] = useState(panelCache?.envPath ?? "");
  const [composeContent, setComposeContent] = useState(panelCache?.composeContent ?? "");
  const [envContent, setEnvContent] = useState(panelCache?.envContent ?? "");
  const [savedComposeContent, setSavedComposeContent] = useState(
    panelCache?.savedComposeContent ?? "",
  );
  const [savedEnvContent, setSavedEnvContent] = useState(panelCache?.savedEnvContent ?? "");
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesReadOnly, setFilesReadOnly] = useState(panelCache?.filesReadOnly ?? false);
  const [savingCompose, setSavingCompose] = useState(false);
  const [savingEnv, setSavingEnv] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [composeActionPending, setComposeActionPending] = useState<"restart" | "rebuild" | null>(
    null,
  );
  const [logsText, setLogsText] = useState(panelCache?.logsText ?? "");
  const [logEnabledByService, setLogEnabledByService] = useState<Record<string, boolean>>(
    () => panelCache?.logEnabledByService ?? {},
  );
  const [metaReady, setMetaReady] = useState(panelCache?.metaReady ?? seededMeta.metaReady);
  const [containersRefreshToken, setContainersRefreshToken] = useState(0);

  const composeDirty = composeContent !== savedComposeContent;
  const envDirty = envContent !== savedEnvContent;

  const pathsRef = useRef({
    workingDir,
    configFile,
    composeContent,
    envContent,
    metaReady,
  });
  pathsRef.current = {
    workingDir,
    configFile,
    composeContent,
    envContent,
    metaReady,
  };

  // 状态变更写入内存缓存，关闭 dock 后再打开可回填
  useEffect(() => {
    writeComposePanelCache(connection.connectionId, composeProject, {
      workingDir,
      configFile,
      composePath,
      envPath,
      composeContent,
      envContent,
      savedComposeContent,
      savedEnvContent,
      filesReadOnly,
      metaReady,
      logsText,
      logEnabledByService,
    });
  }, [
    composeContent,
    composePath,
    composeProject,
    configFile,
    connection.connectionId,
    envContent,
    envPath,
    filesReadOnly,
    logEnabledByService,
    logsText,
    metaReady,
    savedComposeContent,
    savedEnvContent,
    workingDir,
  ]);

  const loadProjectMeta = useCallback(async () => {
    const started = performance.now();
    const meta = await getComposeProjectMeta(connection.connectionId, composeProject);
    debugCompose("loadProjectMeta", {
      composeProject,
      ms: Math.round(performance.now() - started),
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

  /**
   * 读 compose/.env：
   * - 已有内容 → 直接跳过
   * - 已有 workingDir（面板缓存 / 上次 meta）→ 跳过昂贵的 dockerListComposeProjects
   * - 否则才拉全量项目列表拿路径，再读文件
   */
  const loadFiles = useCallback(
    async (force = false) => {
      setFilesError(null);
      const snap = pathsRef.current;
      const hasContent = snap.composeContent.length > 0 || snap.envContent.length > 0;
      if (!force && hasContent) {
        debugCompose("loadFiles 跳过：命中面板缓存", {
          composeProject,
          composeBytes: snap.composeContent.length,
          envBytes: snap.envContent.length,
        });
        if (!snap.metaReady) setMetaReady(true);
        return;
      }
      if (!hasContent) {
        setFilesLoading(true);
      }
      const overallStarted = performance.now();
      try {
        let wd = snap.workingDir;
        let cf = snap.configFile;
        let skippedMetaList = false;
        if (wd) {
          skippedMetaList = true;
          setMetaReady(true);
          debugCompose("loadFiles 跳过全量 Compose 列表：已有 workingDir", {
            composeProject,
            workingDir: wd,
            configFile: cf,
          });
        } else {
          const meta = await loadProjectMeta();
          wd = meta?.workingDir ?? null;
          cf = meta?.configFiles?.split(",")[0]?.trim() || null;
        }

        const readRequest = {
          project: composeProject,
          workingDir: wd,
          configFile: cf,
        };
        debugCompose("loadFiles 开始读文件", { ...readRequest, skippedMetaList });
        const readStarted = performance.now();
        const files = await readComposeProjectFiles(connection.connectionId, readRequest);
        debugCompose("loadFiles 完成", {
          composePath: files.composePath,
          envPath: files.envPath,
          composeBytes: files.composeContent.length,
          envBytes: files.envContent.length,
          readMs: Math.round(performance.now() - readStarted),
          totalMs: Math.round(performance.now() - overallStarted),
          skippedMetaList,
        });
        setWorkingDir(files.workingDir ?? wd);
        setComposePath(files.composePath);
        setEnvPath(files.envPath);
        setComposeContent(files.composeContent);
        setEnvContent(files.envContent);
        setSavedComposeContent(files.composeContent);
        setSavedEnvContent(files.envContent);
        setFilesReadOnly(false);
        setMetaReady(Boolean(files.workingDir ?? wd));
      } catch (e) {
        debugCompose("loadFiles 失败", {
          error: String(e),
          totalMs: Math.round(performance.now() - overallStarted),
        });
        setFilesError(String(e));
        setFilesReadOnly(true);
        setMetaReady(true);
      } finally {
        setFilesLoading(false);
      }
    },
    [composeProject, connection.connectionId, loadProjectMeta],
  );

  useEffect(() => {
    if (!isActive) return;
    void loadFiles(false);
  }, [isActive, connection.connectionId, composeProject, loadFiles]);

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
          setContainersRefreshToken((n) => n + 1);
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

  const handleLogEnabledChange = useCallback((next: Record<string, boolean>) => {
    setLogEnabledByService(next);
  }, []);

  const handleLogsTextChange = useCallback((text: string) => {
    setLogsText(text);
  }, []);

  // 非激活：keep-alive（CSS 隐藏），子列用 isActive 停拉取/日志流，避免切回丢失滚动与编辑态
  return (
    <div
      className={`docker-compose-panel${isActive ? "" : " docker-compose-panel--inactive"}`}
      aria-hidden={!isActive}
    >
      <div className="docker-compose-panel__header">
        <h2
          className="docker-compose-panel__title"
          title={[connection.name, connection.hostLabel, workingDir].filter(Boolean).join(" · ")}
        >
          <span className="docker-compose-panel__title-name">{composeProject}</span>
          <span className="docker-compose-panel__title-meta">
            {connection.name}
            {connection.hostLabel ? ` · ${connection.hostLabel}` : ""}
            {workingDir ? ` · ${workingDir}` : ""}
          </span>
        </h2>
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

      {filesError || actionError ? (
        <div className="docker-compose-panel__error">{filesError ?? actionError}</div>
      ) : null}

      <div className="docker-compose-panel__body">
        <DockLayout direction="horizontal" className="docker-compose-panel__split">
          <DockPanel defaultSize="20%" minSize="14%" maxSize="35%" className="docker-compose-panel__list-pane">
            <DockerComposeContainersColumn
              connection={connection}
              composeProject={composeProject}
              isActive={isActive}
              refreshToken={containersRefreshToken}
              logEnabledByService={logEnabledByService}
              onLogEnabledByServiceChange={handleLogEnabledChange}
              onActionError={setActionError}
            />
          </DockPanel>
          <DockHandle direction="horizontal" />
          <DockPanel defaultSize="80%" minSize="55%" className="docker-compose-panel__main-pane">
            <DockLayout direction="vertical" className="docker-compose-panel__main-split">
              <DockPanel defaultSize="62%" minSize="35%" className="docker-compose-panel__editors-pane">
                <DockLayout direction="horizontal" className="docker-compose-panel__editors-split">
                  <DockPanel defaultSize="50%" minSize="30%" className="docker-compose-panel__compose-editor-pane">
                    {filesLoading && !composeContent ? (
                      <div className="docker-compose-panel__files-loading">
                        {t("docker.composePanel.loadingFiles")}
                      </div>
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
                      <div className="docker-compose-panel__files-loading">
                        {t("docker.composePanel.loadingFiles")}
                      </div>
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
                <DockerComposeLogsColumn
                  connectionId={connection.connectionId}
                  composeProject={composeProject}
                  isActive={isActive}
                  metaReady={metaReady}
                  workingDir={workingDir}
                  configFile={configFile}
                  logEnabledByService={logEnabledByService}
                  initialLogsText={logsText}
                  onLogsTextChange={handleLogsTextChange}
                />
              </DockPanel>
            </DockLayout>
          </DockPanel>
        </DockLayout>
      </div>
    </div>
  );
}
