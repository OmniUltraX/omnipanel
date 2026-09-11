import { useCallback, useEffect, useMemo, useState } from "react";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import { CodeEditor, codeEditorLanguageFromPath } from "../../components/ui/content";
import { FormDialog, FormField } from "../../components/ui/form/FormDialog";
import { TextInput } from "../../components/ui/form/TextInput";
import { Select } from "../../components/ui/form/Select";
import { LogViewer } from "../../components/ui/content";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { WorkbenchPanelHeader } from "../../components/ui/primitives/WorkbenchPanelHeader";
import { useI18n } from "../../i18n";
import { commands, type StudioEnv, type StudioProject, type SubmitPreview } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { askAiFromSurface } from "../../lib/ai/surfaces";
import { useAiStore } from "../../stores/aiStore";
import {
  excerptStudioFile,
  readPluginStudioAutoOpenAiDock,
  tailStudioLog,
  usePluginStudioAiStore,
  writePluginStudioAutoOpenAiDock,
} from "../../stores/pluginStudioAiStore";
import {
  PLUGIN_STUDIO_FILE_WRITTEN_EVENT,
  type PluginStudioFileWrittenDetail,
} from "./studioFileEvents";
import { StudioSubmitDialog } from "./StudioSubmitDialog";

/** 与 PluginKind 七种身份对齐。 */
const PLUGIN_KINDS = [
  "engine",
  "panel",
  "importer",
  "cloud",
  "module",
  "theme",
  "addon",
] as const;

const ENV_CORE = ["node", "cargo"] as const;
type EnvTool = "node" | "cargo" | "wat2wasm";

function appendLog(setLog: (updater: (prev: string) => string) => void, text: string): void {
  setLog((prev) => (prev ? `${prev}\n${text}` : text));
}

function defaultStarter(kind: string): string {
  if (kind === "engine") return "sidecar";
  if (kind === "addon") return "js";
  return "blank";
}

function manifestHint(file: string, content: string): { ok: boolean; text: string } | null {
  if (file !== "plugin.json") return null;
  try {
    parsePluginManifest(JSON.parse(content) as unknown);
    return { ok: true, text: "" };
  } catch (err) {
    return { ok: false, text: String(err) };
  }
}

export function StudioPanel({ active = true }: { active?: boolean }) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [project, setProject] = useState<string>("");
  const [file, setFile] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [savedContent, setSavedContent] = useState<string>("");
  const [log, setLog] = useState<string>("");
  const [logOpen, setLogOpen] = useState(false);
  const [running, setRunning] = useState<string>("");
  const [lastStatus, setLastStatus] = useState<string>("");
  const [env, setEnv] = useState<StudioEnv | null>(null);
  const [newName, setNewName] = useState<string>("");
  const [newKind, setNewKind] = useState<string>("addon");
  const [newStarter, setNewStarter] = useState<string>("js");
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [aiDesc, setAiDesc] = useState<string>("");
  const [artifact, setArtifact] = useState<string>("");
  const [perms, setPerms] = useState<string[]>([]);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitPreview, setSubmitPreview] = useState<SubmitPreview | null>(null);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitSending, setSubmitSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [artifactUrl, setArtifactUrl] = useState("");
  const [changelog, setChangelog] = useState("");
  const [repo, setRepo] = useState("OmniUltraX/omnipanel");
  const [tokenDraft, setTokenDraft] = useState("");
  const [installing, setInstalling] = useState<string>("");

  const dirty = content !== savedContent;
  const current = projects.find((item) => item.name === project);
  const needsWasm = Boolean(current?.files.some((rel) => rel.endsWith(".wat") || rel.endsWith(".wasm")));
  const envTools: EnvTool[] = needsWasm ? ["node", "cargo", "wat2wasm"] : [...ENV_CORE];
  const missingEnv = envTools.filter((tool) => !env?.[tool]);
  const envBusy = installing !== "" || running.startsWith("env:");
  const hint = manifestHint(file, content);
  const busy = running !== "";

  const kindOptions = PLUGIN_KINDS.map((kind) => ({
    value: kind,
    label: t(`plugins.studio.kindLabels.${kind}`),
  }));
  const starterOptions = useMemo(() => {
    if (newKind === "engine") {
      return [
        { value: "sidecar", label: t("plugins.studio.starters.engineSidecar") },
        { value: "blank", label: t("plugins.studio.starters.engineBlank") },
      ];
    }
    if (newKind === "addon") {
      return [
        { value: "js", label: t("plugins.studio.starters.addonJs") },
        { value: "overlay", label: t("plugins.studio.starters.addonOverlay") },
        { value: "wasm", label: t("plugins.studio.starters.addonWasm") },
        { value: "blank", label: t("plugins.studio.starters.addonBlank") },
      ];
    }
    return [];
  }, [newKind, t]);

  const confirmLeave = useCallback((): boolean => {
    if (!dirty) return true;
    return window.confirm(t("plugins.studio.discardConfirm"));
  }, [dirty, t]);

  const reloadProjects = useCallback(async (select?: string) => {
    try {
      const list = await unwrapCommand(commands.pluginStudioListProjects(), { quiet: true });
      setProjects(list);
      if (select && list.some((item) => item.name === select)) {
        setProject(select);
      } else if (select) {
        setProject("");
        setFile("");
        setContent("");
        setSavedContent("");
      } else if (project && !list.some((item) => item.name === project)) {
        setProject("");
        setFile("");
        setContent("");
        setSavedContent("");
      }
      return list;
    } catch (err) {
      appendLog(setLog, String(err));
      return [];
    }
  }, [project]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await unwrapCommand(commands.pluginStudioListProjects(), { quiet: true });
        if (!cancelled) setProjects(list);
      } catch (err) {
        if (!cancelled) appendLog(setLog, String(err));
      }
    })();
    void (async () => {
      try {
        const info = await unwrapCommand(commands.pluginStudioEnvCheck(), { quiet: true });
        if (cancelled) return;
        setEnv(info);
      } catch (err) {
        if (!cancelled) appendLog(setLog, String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadEnv = useCallback(async () => {
    try {
      const info = await unwrapCommand(commands.pluginStudioEnvCheck(), { quiet: true });
      setEnv(info);
      return info;
    } catch (err) {
      appendLog(setLog, String(err));
      return null;
    }
  }, []);

  const openFile = useCallback(
    async (projectName: string, rel: string, force = false) => {
      if (!force && dirty && project === projectName && file && file !== rel && !confirmLeave()) return;
      if (!force && dirty && project !== projectName && !confirmLeave()) return;
      try {
        const text = await unwrapCommand(commands.pluginStudioReadFile(projectName, rel));
        setProject(projectName);
        setFile(rel);
        setContent(text);
        setSavedContent(text);
      } catch (err) {
        appendLog(setLog, String(err));
      }
    },
    [confirmLeave, dirty, file, project],
  );

  const selectProject = useCallback(
    async (name: string) => {
      if (name === project) return;
      if (dirty && !confirmLeave()) return;
      setProject(name);
      setArtifact("");
      setPerms([]);
      setLastStatus("");
      const item = projects.find((entry) => entry.name === name);
      if (item?.hasManifest) {
        await openFile(name, "plugin.json", true);
      } else {
        setFile("");
        setContent("");
        setSavedContent("");
      }
    },
    [confirmLeave, dirty, openFile, project, projects],
  );

  const saveFile = useCallback(async () => {
    if (!project || !file || running) return;
    try {
      await unwrapCommand(commands.pluginStudioWriteFile(project, file, content));
      setSavedContent(content);
      appendLog(setLog, `${t("plugins.studio.saved")}: ${file}`);
      if (file === "plugin.json") void reloadProjects(project);
    } catch (err) {
      appendLog(setLog, String(err));
    }
  }, [content, file, project, reloadProjects, running, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveFile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveFile]);

  useEffect(() => {
    if (!active) {
      usePluginStudioAiStore.getState().clear();
      return;
    }
    usePluginStudioAiStore.getState().setSnapshot({
      active: true,
      project,
      file,
      kind: current?.kind ?? null,
      version: current?.version ?? null,
      displayName: current?.displayName ?? null,
      dirty,
      files: current?.files ?? [],
      lastLogTail: tailStudioLog(log),
      lastStatus,
      manifestOk: hint?.ok ?? null,
      manifestHint: hint?.text ?? "",
      fileExcerpt: excerptStudioFile(content),
    });
  }, [
    active,
    content,
    current?.displayName,
    current?.files,
    current?.kind,
    current?.version,
    dirty,
    file,
    hint?.ok,
    hint?.text,
    lastStatus,
    log,
    project,
  ]);

  useEffect(() => {
    return () => {
      usePluginStudioAiStore.getState().clear();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const unsub = useAiStore.subscribe((state, prev) => {
      if (state.drawerOpen === prev.drawerOpen) return;
      writePluginStudioAutoOpenAiDock(state.drawerOpen);
    });
    if (readPluginStudioAutoOpenAiDock()) {
      useAiStore.getState().openDrawer();
    }
    return unsub;
  }, [active]);

  useEffect(() => {
    const onWritten = (event: Event) => {
      const detail = (event as CustomEvent<PluginStudioFileWrittenDetail>).detail;
      if (!detail) return;
      if (detail.project === project && detail.path === file) {
        void openFile(detail.project, detail.path, true);
        return;
      }
      void reloadProjects(project || detail.project);
    };
    window.addEventListener(PLUGIN_STUDIO_FILE_WRITTEN_EVENT, onWritten);
    return () => window.removeEventListener(PLUGIN_STUDIO_FILE_WRITTEN_EVENT, onWritten);
  }, [file, openFile, project, reloadProjects]);

  const installEnv = useCallback(
    async (tool: EnvTool) => {
      if (installing || running) return;
      setInstalling(tool);
      setRunning(`env:${tool}`);
      setLogOpen(true);
      try {
        const ret = await unwrapCommand(commands.pluginStudioEnvInstall(tool), { quiet: true });
        appendLog(setLog, ret.output || `${tool}: ${ret.ok ? "ok" : "fail"}`);
        await reloadEnv();
        appendLog(
          setLog,
          ret.ok
            ? t("plugins.studio.envInstallOk", { tool, version: ret.version ?? t("plugins.studio.envOk") })
            : t("plugins.studio.envInstallFail", { tool }),
        );
      } catch (err) {
        appendLog(setLog, String(err));
      } finally {
        setInstalling("");
        setRunning("");
      }
    },
    [installing, reloadEnv, running, t],
  );

  const installMissing = useCallback(async () => {
    for (const tool of envTools) {
      if (env?.[tool]) continue;
      await installEnv(tool);
    }
  }, [env, envTools, installEnv]);

  const runOp = useCallback(
    async (op: "validate" | "pack") => {
      if (!project || running) return;
      if (dirty && file) await saveFile();
      setRunning(op);
      setArtifact("");
      setPerms([]);
      setLogOpen(true);
      try {
        const ret = await unwrapCommand(commands.pluginStudioRun(project, op), { quiet: true });
        appendLog(setLog, ret.output);
        if (ret.success) {
          setLastStatus(op === "pack" ? t("plugins.studio.packOk") : t("plugins.studio.validateOk"));
        } else {
          setLastStatus(op === "pack" ? t("plugins.studio.packFail") : t("plugins.studio.validateFail"));
        }
        if (ret.success && ret.artifactPath) {
          setArtifact(ret.artifactPath);
          try {
            const manifestJson = await unwrapCommand(commands.pluginPeekManifest(ret.artifactPath));
            const manifest = parsePluginManifest(JSON.parse(manifestJson) as unknown);
            setPerms([...manifest.permissions]);
          } catch (err) {
            appendLog(setLog, String(err));
          }
        }
      } catch (err) {
        setLastStatus(op === "pack" ? t("plugins.studio.packFail") : t("plugins.studio.validateFail"));
        appendLog(setLog, String(err));
      } finally {
        setRunning("");
        void reloadProjects(project);
      }
    },
    [dirty, file, project, reloadProjects, running, saveFile, t],
  );

  const installArtifact = useCallback(async () => {
    if (!artifact || running) return;
    setRunning("install");
    setLogOpen(true);
    try {
      await unwrapCommand(commands.pluginInstallFromFile(artifact));
      appendLog(setLog, t("plugins.studio.installOk"));
      setLastStatus(t("plugins.studio.installOk"));
      setArtifact("");
      setPerms([]);
    } catch (err) {
      appendLog(setLog, String(err));
    } finally {
      setRunning("");
    }
  }, [artifact, running, t]);

  const createProject = useCallback(async () => {
    if (!newName.trim() || running) return;
    setRunning("create");
    setCreateError(null);
    try {
      const starter = starterOptions.length > 0 ? newStarter : null;
      const created = await unwrapCommand(
        commands.pluginStudioScaffold(newName.trim(), newKind, starter),
        { quiet: true },
      );
      setNewName("");
      setNewKind("addon");
      setNewStarter("js");
      setCreateOpen(false);
      await reloadProjects(created.name);
      if (created.hasManifest) await openFile(created.name, "plugin.json", true);
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setRunning("");
    }
  }, [newKind, newName, newStarter, openFile, reloadProjects, running, starterOptions.length]);

  const removeProject = useCallback(async () => {
    if (!project || running) return;
    setRunning("remove");
    try {
      await unwrapCommand(commands.pluginStudioRemoveProject(project), { quiet: true });
      setRemoveOpen(false);
      setProject("");
      setFile("");
      setContent("");
      setSavedContent("");
      setArtifact("");
      setPerms([]);
      await reloadProjects();
    } catch (err) {
      appendLog(setLog, String(err));
    } finally {
      setRunning("");
    }
  }, [project, reloadProjects, running]);

  const askStudio = useCallback(
    async (kind: "ask" | "generate" | "explain") => {
      const extra = aiDesc.trim();
      let prompt: string;
      if (kind === "generate") {
        if (!extra) return;
        prompt = t("plugins.studio.aiGeneratePrompt", {
          project: project || t("plugins.studio.noProject"),
          desc: extra,
        });
        try {
          await unwrapCommand(
            commands.pluginStudioAuditScaffold(project || "_", extra),
            { quiet: true },
          );
        } catch {
          /* 审计失败不阻断生成 */
        }
      } else if (kind === "explain") {
        prompt = extra
          ? `${t("plugins.studio.aiExplainPrompt")}\n\n${extra}`
          : t("plugins.studio.aiExplainPrompt");
      } else {
        prompt = extra
          ? `${t("plugins.studio.aiAskPrompt")}\n\n${extra}`
          : t("plugins.studio.aiAskPrompt");
      }
      await askAiFromSurface({
        prompt,
        surface: "dashboard",
        newConversation: false,
      });
    },
    [aiDesc, project, t],
  );

  const previewSubmit = useCallback(async () => {
    if (!project || !artifactUrl.trim()) return;
    setSubmitLoading(true);
    setSubmitError(null);
    try {
      const preview = await unwrapCommand(
        commands.pluginSubmitPreview(
          project,
          artifactUrl.trim(),
          changelog.trim() || null,
          repo.trim() || null,
          artifact || null,
        ),
      );
      setSubmitPreview(preview);
    } catch (err) {
      setSubmitError(String(err));
    } finally {
      setSubmitLoading(false);
    }
  }, [artifact, artifactUrl, changelog, project, repo]);

  const saveSubmitToken = useCallback(async () => {
    if (!tokenDraft.trim()) return;
    setSubmitError(null);
    try {
      await unwrapCommand(commands.pluginStudioGithubTokenPut(tokenDraft.trim()));
      setTokenDraft("");
      const preview = submitPreview
        ? { ...submitPreview, hasToken: true }
        : await unwrapCommand(commands.pluginSubmitPreview(
            project,
            artifactUrl.trim(),
            changelog.trim() || null,
            repo.trim() || null,
            artifact || null,
          ));
      setSubmitPreview(preview);
    } catch (err) {
      setSubmitError(String(err));
    }
  }, [artifact, artifactUrl, changelog, project, repo, submitPreview, tokenDraft]);

  const confirmSubmit = useCallback(async () => {
    if (!project || !artifactUrl.trim()) return;
    setSubmitSending(true);
    setSubmitError(null);
    try {
      const result = await unwrapCommand(
        commands.pluginSubmitIssue(
          project,
          artifactUrl.trim(),
          changelog.trim() || null,
          repo.trim() || null,
          artifact || null,
        ),
      );
      appendLog(setLog, t("plugins.studio.submit.done", { url: result.url }));
      setSubmitOpen(false);
      setSubmitPreview(null);
    } catch (err) {
      setSubmitError(String(err));
    } finally {
      setSubmitSending(false);
    }
  }, [artifact, artifactUrl, changelog, project, repo, t]);

  const headerTags = [
    { text: current?.displayName || project || t("plugins.studio.noProject"), emphasis: true },
    ...(current?.kind
      ? [{ text: t(`plugins.studio.kindLabels.${current.kind}`) }]
      : []),
    ...(current?.version ? [{ text: current.version }] : []),
    ...(dirty ? [{ text: t("plugins.studio.unsaved") }] : []),
    ...(lastStatus ? [{ text: lastStatus }] : []),
    ...(running ? [{ text: t("plugins.studio.running") }] : []),
  ];

  return (
    <div className="plugin-center plugin-studio">
      <WorkbenchPanelHeader
        label={t("plugins.studio.open")}
        tags={headerTags}
        actions={
          <>
            <WorkbenchActionButton disabled={!dirty || !file || busy} onClick={() => void saveFile()}>
              {t("plugins.studio.save")}
            </WorkbenchActionButton>
            <WorkbenchActionButton disabled={!project || busy} onClick={() => void runOp("validate")}>
              {t("plugins.studio.validate")}
            </WorkbenchActionButton>
            <WorkbenchActionButton disabled={!project || busy} onClick={() => void runOp("pack")}>
              {t("plugins.studio.pack")}
            </WorkbenchActionButton>
            {artifact ? (
              <WorkbenchActionButton disabled={busy} onClick={() => void installArtifact()}>
                {t("plugins.studio.install")}
              </WorkbenchActionButton>
            ) : null}
            <WorkbenchActionButton
              disabled={!project || busy}
              onClick={() => {
                setSubmitError(null);
                setSubmitPreview(null);
                setSubmitOpen(true);
              }}
            >
              {t("plugins.studio.submit.action")}
            </WorkbenchActionButton>
          </>
        }
      />
      <div className="plugin-studio-body">
        <aside className="plugin-studio-side">
          <section className="plugin-studio-block plugin-studio-block--grow">
            <div className="plugin-center-col__head">
              {t("plugins.studio.projects")}
              <span className="plugin-studio-count">{projects.length}</span>
              <span className="plugin-studio-env-actions">
                <WorkbenchActionButton
                  disabled={busy}
                  onClick={() => {
                    setCreateError(null);
                    setCreateOpen(true);
                  }}
                >
                  {t("plugins.studio.add")}
                </WorkbenchActionButton>
              </span>
            </div>
            <div className="plugin-center-list">
              {projects.length === 0 ? (
                <p className="plugin-center-empty">{t("plugins.studio.emptyProjects")}</p>
              ) : (
                projects.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    className={`plugin-center-row${project === item.name ? " is-active" : ""}`}
                    onClick={() => void selectProject(item.name)}
                  >
                    <span className="plugin-center-row__name">{item.displayName || item.name}</span>
                    <span className="plugin-center-row__meta">
                      {item.kind ? t(`plugins.studio.kindLabels.${item.kind}`) : item.name}
                      {item.version ? ` · ${item.version}` : ""}
                      {item.location === "repo"
                        ? ` · ${t("plugins.studio.locationRepo")}`
                        : ` · ${t("plugins.studio.locationUser")}`}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>
          {current ? (
            <section className="plugin-studio-block plugin-studio-block--files">
              <div className="plugin-center-col__head">
                {t("plugins.studio.files")}
                <span className="plugin-studio-count">{current.files.length}</span>
                <span className="plugin-studio-env-actions">
                  <WorkbenchActionButton danger disabled={busy} onClick={() => setRemoveOpen(true)}>
                    {t("plugins.studio.deleteProject")}
                  </WorkbenchActionButton>
                </span>
              </div>
              <div className="plugin-center-list plugin-studio-files">
                {current.files.map((rel) => (
                  <button
                    key={rel}
                    type="button"
                    className={`plugin-center-row plugin-studio-file${file === rel ? " is-active" : ""}`}
                    onClick={() => void openFile(current.name, rel)}
                  >
                    <span className="plugin-center-row__name">{rel}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <section className="plugin-studio-block">
            <div className="plugin-center-col__head">
              {t("plugins.studio.env")}
              <span className="plugin-studio-env-actions">
                <WorkbenchActionButton disabled={envBusy} onClick={() => void reloadEnv()}>
                  {t("plugins.studio.envRefresh")}
                </WorkbenchActionButton>
                {missingEnv.length > 0 ? (
                  <WorkbenchActionButton disabled={envBusy} onClick={() => void installMissing()}>
                    {t("plugins.studio.envInstallAll")}
                  </WorkbenchActionButton>
                ) : null}
              </span>
            </div>
            <div className="plugin-studio-env-list">
              {envTools.map((tool) => {
                const ver = env?.[tool];
                const toolBusy = installing === tool;
                return (
                  <div key={tool} className="plugin-studio-env-row">
                    <span className="plugin-studio-env-name">{tool}</span>
                    <span className={`plugin-studio-env-ver${ver ? "" : " is-missing"}`}>
                      {toolBusy ? t("plugins.studio.envInstalling") : ver || t("plugins.studio.envMissing")}
                    </span>
                    {ver || toolBusy ? null : (
                      <WorkbenchActionButton disabled={envBusy} onClick={() => void installEnv(tool)}>
                        {t("plugins.studio.envInstall")}
                      </WorkbenchActionButton>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </aside>
        <div className="plugin-studio-main">
          <div className="plugin-studio-filebar">
            <span className="plugin-studio-filebar__path" title={file || undefined}>
              {file ? `${project}/${file}` : t("plugins.studio.noFile")}
            </span>
            <WorkbenchActionButton onClick={() => setLogOpen((open) => !open)}>
              {logOpen ? t("plugins.studio.hideLog") : t("plugins.studio.showLog")}
            </WorkbenchActionButton>
          </div>
          <div className="plugin-studio-ai">
            <TextInput
              value={aiDesc}
              onChange={setAiDesc}
              placeholder={t("plugins.studio.aiPlaceholder")}
              size="sm"
              clearable
              copyable={false}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void askStudio("ask");
                }
              }}
            />
            <WorkbenchActionButton disabled={busy} onClick={() => void askStudio("ask")}>
              {t("plugins.studio.aiAsk")}
            </WorkbenchActionButton>
            <WorkbenchActionButton
              disabled={!aiDesc.trim() || busy}
              onClick={() => void askStudio("generate")}
            >
              {t("plugins.studio.aiGenerate")}
            </WorkbenchActionButton>
            <WorkbenchActionButton disabled={busy} onClick={() => void askStudio("explain")}>
              {t("plugins.studio.aiExplain")}
            </WorkbenchActionButton>
          </div>
          <div className="plugin-studio-editor">
            {file ? (
              <CodeEditor
                value={content}
                onChange={setContent}
                language={codeEditorLanguageFromPath(file)}
                height="100%"
              />
            ) : (
              <div className="plugin-studio-empty">
                <p className="plugin-studio-empty__title">{t("plugins.studio.emptySteps")}</p>
                <ol className="plugin-studio-empty__steps">
                  <li>{t("plugins.studio.emptyStep1")}</li>
                  <li>{t("plugins.studio.emptyStep2")}</li>
                  <li>{t("plugins.studio.emptyStep3")}</li>
                  <li>{t("plugins.studio.emptyStepAi")}</li>
                </ol>
                <WorkbenchActionButton
                  onClick={() => {
                    setCreateError(null);
                    setCreateOpen(true);
                  }}
                >
                  {t("plugins.studio.add")}
                </WorkbenchActionButton>
              </div>
            )}
          </div>
          {hint ? (
            <p className={`plugin-studio-manifest${hint.ok ? " is-ok" : " is-bad"}`}>
              {hint.ok ? t("plugins.studio.manifestOk") : `${t("plugins.studio.manifestBad")}: ${hint.text}`}
            </p>
          ) : null}
          {artifact ? (
            <div className="plugin-studio-artifact">
              <div className="plugin-center-col__head">{t("plugins.studio.permsTitle")}</div>
              <p className="plugin-studio-artifact__perms">
                {perms.length === 0 ? t("plugins.install.noPermissions") : perms.join(", ")}
              </p>
              <WorkbenchActionButton disabled={busy} onClick={() => void installArtifact()}>
                {t("plugins.studio.installConfirm")}
              </WorkbenchActionButton>
            </div>
          ) : null}
          {logOpen ? (
            <div className="plugin-studio-log">
              <div className="plugin-center-col__head">{t("plugins.studio.log")}</div>
              <LogViewer text={log} emptyText={t("plugins.studio.log")} />
            </div>
          ) : null}
        </div>
      </div>
      <FormDialog
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setCreateError(null);
        }}
        title={t("plugins.studio.newProject")}
        size="sm"
        status={createError ? { kind: "error", message: createError } : null}
        primaryAction={{
          label: t("plugins.studio.create"),
          disabled: !newName.trim() || busy,
          onClick: () => void createProject(),
        }}
      >
        <FormField label={t("plugins.studio.name")} hint={t("plugins.studio.nameHint")}>
          <TextInput
            value={newName}
            onChange={setNewName}
            placeholder={t("plugins.studio.namePlaceholder")}
            clearable
            copyable={false}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void createProject();
              }
            }}
          />
        </FormField>
        <FormField label={t("plugins.studio.kind")}>
          <Select
            value={newKind}
            onChange={(value) => {
              setNewKind(value);
              setNewStarter(defaultStarter(value));
            }}
            options={kindOptions}
            searchable={false}
            aria-label={t("plugins.studio.kind")}
          />
        </FormField>
        {starterOptions.length > 0 ? (
          <FormField label={t("plugins.studio.starter")} hint={t("plugins.studio.starterHint")}>
            <Select
              value={newStarter}
              onChange={setNewStarter}
              options={starterOptions}
              searchable={false}
              aria-label={t("plugins.studio.starter")}
            />
          </FormField>
        ) : null}
      </FormDialog>
      <FormDialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        title={t("plugins.studio.deleteProject")}
        size="sm"
        primaryAction={{
          label: t("plugins.studio.deleteProject"),
          variant: "danger",
          disabled: busy,
          onClick: () => void removeProject(),
        }}
      >
        <p>{t("plugins.studio.deleteConfirm", { name: project })}</p>
      </FormDialog>
      <StudioSubmitDialog
        open={submitOpen}
        project={project}
        preview={submitPreview}
        loading={submitLoading}
        submitting={submitSending}
        error={submitError}
        tokenDraft={tokenDraft}
        artifactUrl={artifactUrl}
        changelog={changelog}
        repo={repo}
        onArtifactUrl={setArtifactUrl}
        onChangelog={setChangelog}
        onRepo={setRepo}
        onTokenDraft={setTokenDraft}
        onPreview={() => void previewSubmit()}
        onSaveToken={() => void saveSubmitToken()}
        onSubmit={() => void confirmSubmit()}
        onClose={() => {
          setSubmitOpen(false);
          setSubmitError(null);
        }}
      />
    </div>
  );
}
