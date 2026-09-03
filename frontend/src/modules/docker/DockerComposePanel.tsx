import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DockHandle, DockLayout, DockPanel } from "../../components/dock";
import { Button } from "../../components/ui/Button";
import { CodeEditor, codeEditorLanguageFromPath, type CodeEditorLanguage } from "../../components/ui/content/CodeEditor";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import type { DockerConnectionInfo } from "../../ipc/bindings";
import { useDockerPanelDockStore } from "../../stores/dockerPanelDockStore";
import {
  getComposeProjectMeta,
  invalidateComposeProjectMeta,
  isComposeFilesCacheFresh,
  peekComposeFilesCache,
  peekComposeProjectMeta,
  readComposeProjectFiles,
  runComposeAction,
  warmComposeMetaFromContainers,
  writeComposeProjectFiles,
} from "./dockerComposeApi";
import { refreshDockerConnectionSidebarCache } from "./hooks/useDockerConnectionResources";
import { debugCompose, beginComposeDebug } from "./dockerComposeDebug";
import {
  peekComposePanelCache,
  seedComposePanelFromMeta,
  writeComposePanelCache,
} from "./dockerComposePanelCache";
import { DockerComposeContainersColumn } from "./DockerComposeContainersColumn";
import { DockerComposeLogsColumn } from "./DockerComposeLogsColumn";
import { useDockerSidebarCacheStore } from "../../stores/dockerSidebarCacheStore";

/** 同连接+项目合并并发 loadFiles，避免 Strict Mode 双跑整条链路 */
const loadFilesInflight = new Map<string, Promise<void>>();

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
  const filesCache = useMemo(
    () => peekComposeFilesCache(connection.connectionId, composeProject),
    [connection.connectionId, composeProject],
  );
  const seededMeta = useMemo(() => seedComposePanelFromMeta(cachedMeta), [cachedMeta]);

  const [workingDir, setWorkingDir] = useState<string | null>(
    panelCache?.workingDir ?? filesCache?.workingDir ?? seededMeta.workingDir,
  );
  const [configFile, setConfigFile] = useState<string | null>(
    panelCache?.configFile ?? filesCache?.configFile ?? seededMeta.configFile,
  );
  const [composePath, setComposePath] = useState(
    panelCache?.composePath ?? filesCache?.files.composePath ?? "",
  );
  const [envPath, setEnvPath] = useState(panelCache?.envPath ?? filesCache?.files.envPath ?? "");
  const [composeContent, setComposeContent] = useState(
    panelCache?.composeContent ?? filesCache?.files.composeContent ?? "",
  );
  const [envContent, setEnvContent] = useState(
    panelCache?.envContent ?? filesCache?.files.envContent ?? "",
  );
  const [savedComposeContent, setSavedComposeContent] = useState(
    panelCache?.savedComposeContent ?? filesCache?.files.composeContent ?? "",
  );
  const [savedEnvContent, setSavedEnvContent] = useState(
    panelCache?.savedEnvContent ?? filesCache?.files.envContent ?? "",
  );
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesReadOnly, setFilesReadOnly] = useState(panelCache?.filesReadOnly ?? false);
  const [savingCompose, setSavingCompose] = useState(false);
  const [savingEnv, setSavingEnv] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [composeActionPending, setComposeActionPending] = useState<
    "stop" | "restart" | "rebuild" | "down" | null
  >(null);
  const [logsText, setLogsText] = useState(panelCache?.logsText ?? "");
  const [logEnabledByService] = useState<Record<string, boolean>>(
    () => panelCache?.logEnabledByService ?? {},
  );
  const [metaReady, setMetaReady] = useState(panelCache?.metaReady ?? seededMeta.metaReady);
  const [containersRefreshToken, setContainersRefreshToken] = useState(0);

  const composeDirty = composeContent !== savedComposeContent;
  const envDirty = envContent !== savedEnvContent;
  const dirtyRef = useRef({ composeDirty, envDirty });
  dirtyRef.current = { composeDirty, envDirty };

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

  const applyRemoteFiles = useCallback(
    (
      files: {
        workingDir: string | null;
        composePath: string;
        envPath: string;
        composeContent: string;
        envContent: string;
      },
      fallbackWorkingDir: string | null,
      options?: { respectDirty?: boolean },
    ) => {
      const respectDirty = options?.respectDirty !== false;
      const dirty = dirtyRef.current;
      setWorkingDir(files.workingDir ?? fallbackWorkingDir);
      setComposePath(files.composePath);
      setEnvPath(files.envPath);
      if (!respectDirty || !dirty.composeDirty) {
        setComposeContent(files.composeContent);
        setSavedComposeContent(files.composeContent);
      } else {
        setSavedComposeContent(files.composeContent);
      }
      if (!respectDirty || !dirty.envDirty) {
        setEnvContent(files.envContent);
        setSavedEnvContent(files.envContent);
      } else {
        setSavedEnvContent(files.envContent);
      }
      setFilesReadOnly(false);
      setMetaReady(Boolean(files.workingDir ?? fallbackWorkingDir));
    },
    [],
  );

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
    const span = beginComposeDebug("loadProjectMeta", {
      connectionId: connection.connectionId,
      composeProject,
    });
    const meta = await getComposeProjectMeta(connection.connectionId, composeProject);
    span.end("完成", {
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
   * 读 compose/.env（Stale-while-revalidate）：
   * - 有可用缓存 → 立刻展示，若已过期则后台静默刷新
   * - 新鲜缓存 → 跳过远端
   * - 无缓存 → loading + 拉远端
   * - 已有 workingDir / 侧栏 labels → 跳过全量 list
   */
  const loadFiles = useCallback(
    async (force = false) => {
      const loadKey = `${connection.connectionId}::${composeProject}`;
      if (!force) {
        const existing = loadFilesInflight.get(loadKey);
        if (existing) {
          debugCompose("loadFiles 合并进行中的请求", {
            connectionId: connection.connectionId,
            composeProject,
          });
          await existing;
          return;
        }
      }

      const run = (async () => {
        setFilesError(null);
        const snap = pathsRef.current;
        let hasContent = snap.composeContent.length > 0 || snap.envContent.length > 0;
        const span = beginComposeDebug("loadFiles", {
          connectionId: connection.connectionId,
          composeProject,
          force,
          hasContent,
          cachedWorkingDir: snap.workingDir,
          cachedConfigFile: snap.configFile,
          metaReady: snap.metaReady,
        });

        // 内存面板空时，用持久化文件缓存秒开
        if (!hasContent) {
          const persisted = peekComposeFilesCache(connection.connectionId, composeProject);
          if (persisted) {
            span.step("SWR：展示持久化/内存文件缓存", {
              ageMs: Date.now() - persisted.fetchedAt,
              fresh: isComposeFilesCacheFresh(persisted),
              composeBytes: persisted.files.composeContent.length,
              envBytes: persisted.files.envContent.length,
            });
            applyRemoteFiles(persisted.files, persisted.workingDir, { respectDirty: false });
            if (persisted.workingDir) setWorkingDir(persisted.workingDir);
            if (persisted.configFile) setConfigFile(persisted.configFile);
            hasContent = true;
            pathsRef.current = {
              ...pathsRef.current,
              workingDir: persisted.workingDir ?? pathsRef.current.workingDir,
              configFile: persisted.configFile ?? pathsRef.current.configFile,
              composeContent: persisted.files.composeContent,
              envContent: persisted.files.envContent,
              metaReady: true,
            };
          }
        }

        const filesCacheEntry = peekComposeFilesCache(connection.connectionId, composeProject);
        const cacheFresh = Boolean(filesCacheEntry && isComposeFilesCacheFresh(filesCacheEntry));

        if (!force && hasContent && cacheFresh) {
          span.end("跳过：内容缓存仍新鲜", {
            ageMs: filesCacheEntry ? Date.now() - filesCacheEntry.fetchedAt : null,
            composeBytes: pathsRef.current.composeContent.length,
            envBytes: pathsRef.current.envContent.length,
          });
          if (!pathsRef.current.metaReady) setMetaReady(true);
          return;
        }

        const swrBackground = !force && hasContent;
        if (!swrBackground) {
          setFilesLoading(true);
        } else {
          span.step("SWR：已有内容，后台 revalidate", {
            ageMs: filesCacheEntry ? Date.now() - filesCacheEntry.fetchedAt : null,
          });
        }

        try {
          let wd = pathsRef.current.workingDir;
          let cf = pathsRef.current.configFile;
          let skippedMetaList = false;

          if (!wd) {
            const sidebarContainers =
              useDockerSidebarCacheStore.getState().getEntry(connection.connectionId).containers;
            warmComposeMetaFromContainers(connection.connectionId, sidebarContainers);
            const seeded = peekComposeProjectMeta(connection.connectionId, composeProject);
            if (seeded?.workingDir) {
              wd = seeded.workingDir;
              cf = seeded.configFiles?.split(",")[0]?.trim() || null;
              setWorkingDir(wd);
              setConfigFile(cf);
              span.step("侧栏容器 labels 预热 workingDir", {
                workingDir: wd,
                configFile: cf,
              });
            }
          }

          if (wd) {
            skippedMetaList = true;
            setMetaReady(true);
            span.step("跳过全量 Compose 列表：已有 workingDir", {
              workingDir: wd,
              configFile: cf,
            });
          } else {
            span.step("无 workingDir，开始 loadProjectMeta（可能很慢）");
            const meta = await loadProjectMeta();
            wd = meta?.workingDir ?? null;
            cf = meta?.configFiles?.split(",")[0]?.trim() || null;
            span.step("loadProjectMeta 返回", {
              workingDir: wd,
              configFile: cf,
            });
          }

          const readRequest = {
            project: composeProject,
            workingDir: wd,
            configFile: cf,
          };
          span.step("开始读 compose/.env 文件", {
            ...readRequest,
            skippedMetaList,
            swrBackground,
          });
          const files = await readComposeProjectFiles(connection.connectionId, readRequest, {
            force: force || swrBackground,
          });
          span.step("读文件返回，写回 React state", {
            composePath: files.composePath,
            envPath: files.envPath,
            composeBytes: files.composeContent.length,
            envBytes: files.envContent.length,
            skippedMetaList,
            swrBackground,
            skippedDirtyCompose: dirtyRef.current.composeDirty,
            skippedDirtyEnv: dirtyRef.current.envDirty,
          });
          applyRemoteFiles(files, wd, { respectDirty: swrBackground });
          span.end(swrBackground ? "SWR 后台刷新完成" : "完成");
        } catch (e) {
          span.end("失败", { error: String(e), swrBackground });
          // 后台刷新失败：保留已展示的缓存，不把面板打成只读错误态
          if (!swrBackground) {
            setFilesError(String(e));
            setFilesReadOnly(true);
            setMetaReady(true);
          } else {
            debugCompose("SWR 后台刷新失败（保留缓存展示）", {
              connectionId: connection.connectionId,
              composeProject,
              error: String(e),
            });
          }
        } finally {
          setFilesLoading(false);
        }
      })();

      if (!force) {
        loadFilesInflight.set(loadKey, run);
      }
      try {
        await run;
      } finally {
        if (loadFilesInflight.get(loadKey) === run) {
          loadFilesInflight.delete(loadKey);
        }
      }
    },
    [applyRemoteFiles, composeProject, connection.connectionId, loadProjectMeta],
  );

  useEffect(() => {
    if (!isActive) return;
    debugCompose("Compose 面板激活，触发 loadFiles", {
      connectionId: connection.connectionId,
      composeProject,
    });
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
    (action: "stop" | "restart" | "rebuild" | "down") => {
      void (async () => {
        const confirmMessage =
          action === "stop"
            ? t("docker.composePanel.stopConfirm", { project: composeProject })
            : action === "restart"
              ? t("docker.composePanel.restartConfirm", { project: composeProject })
              : action === "down"
                ? t("docker.composePanel.downConfirm", { project: composeProject })
                : t("docker.composePanel.rebuildConfirm", { project: composeProject });
        const confirmTitle =
          action === "stop"
            ? t("docker.composePanel.stop")
            : action === "restart"
              ? t("docker.composePanel.restart")
              : action === "down"
                ? t("docker.composePanel.down")
                : t("docker.composePanel.rebuild");
        const confirmed = await appConfirm(confirmMessage, confirmTitle, {
          kind: "warning",
          confirmLabel: confirmTitle,
        });
        if (!confirmed) return;

        setActionError(null);
        setComposeActionPending(action);
        try {
          const result = await runComposeAction(connection.connectionId, action, composeActionRequest);
          if (result.exitCode !== 0) {
            const detail = [result.stderrExcerpt, result.stdoutExcerpt].filter(Boolean).join("\n");
            throw new Error(detail || t("docker.composePanel.actionFailed"));
          }
          showActionToast(
            action === "stop"
              ? t("docker.composePanel.stopped")
              : action === "restart"
                ? t("docker.composePanel.restarted")
                : action === "down"
                  ? t("docker.composePanel.downed")
                  : t("docker.composePanel.rebuilt"),
          );
          if (action === "down") {
            invalidateComposeProjectMeta(connection.connectionId, composeProject);
            refreshDockerConnectionSidebarCache(connection.connectionId);
            useDockerPanelDockStore
              .getState()
              .removeComposeTabs(connection.connectionId, composeProject);
            return;
          }
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
            onClick={() => handleComposeLifecycle("stop")}
          >
            {composeActionPending === "stop"
              ? t("docker.composePanel.stopping")
              : t("docker.composePanel.stop")}
          </Button>
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
          <Button
            size="sm"
            variant="secondary"
            disabled={composeActionPending != null}
            onClick={() => handleComposeLifecycle("down")}
          >
            {composeActionPending === "down"
              ? t("docker.composePanel.downing")
              : t("docker.composePanel.down")}
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
