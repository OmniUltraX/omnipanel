import { useCallback, useEffect, useState } from "react";
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
import { extractFencedBlocks } from "./scaffoldFormat";
import { StudioSubmitDialog } from "./StudioSubmitDialog";

/** 与 PluginKind 七种身份对齐，不把脚手架内部模板（js-logic 等）暴露给用户。 */
const PLUGIN_KINDS = [
  "engine",
  "panel",
  "importer",
  "cloud",
  "module",
  "theme",
  "addon",
] as const;

const ENV_TOOLS = ["node", "cargo", "wat2wasm"] as const;
type EnvTool = (typeof ENV_TOOLS)[number];

/**
 * AI 生成骨架的定版模板：约束输出恰好三段围栏代码块，
 * 只用平台真实能力（host.ui.menu/aiComplete 等），不许编造 API。
 */
const SCAFFOLD_SYSTEM = [
  "你是 OmniPanel 第三方插件脚手架。只输出三段 fenced 代码块，顺序固定：",
  "```plugin.json（合法清单：id 反向域名、kind 七选一、permissions 按需最小、entry.ui=ui/main.js（如需前端逻辑）、overlays 声明 L3 页）",
  "```main.js（CommonJS：module.exports = definePlugin({activate, deactivate})，可用 host/ui/menu/aiComplete/overlay.open，deactivate 必须卸除登记）",
  "```index.html（L3 沙箱页：用 var(--fg) 等主题变量与 .omni-card/.omni-toolbar 类，不过问宿主 DOM）",
  "不要任何解释、前言、注释外的文字；JSON 必须可解析。",
].join("\n");

function appendLog(setLog: (updater: (prev: string) => string) => void, text: string): void {
  setLog((prev) => (prev ? `${prev}\n${text}` : text));
}

export function StudioPanel() {
  const { t } = useI18n();
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [project, setProject] = useState<string>("");
  const [file, setFile] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [savedContent, setSavedContent] = useState<string>("");
  const [log, setLog] = useState<string>("");
  const [running, setRunning] = useState<string>("");
  const [env, setEnv] = useState<StudioEnv | null>(null);
  const [newName, setNewName] = useState<string>("");
  const [newKind, setNewKind] = useState<string>("addon");
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
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

  const reloadProjects = useCallback(async (select?: string) => {
    try {
      const list = await unwrapCommand(commands.pluginStudioListProjects(), { quiet: true });
      setProjects(list);
      if (select && list.some((p) => p.name === select)) {
        setProject(select);
      } else if (!list.some((p) => p.name === project)) {
        setProject("");
        setFile("");
        setContent("");
        setSavedContent("");
      }
    } catch (err) {
      appendLog(setLog, String(err));
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
        if (!info.repoRoot) appendLog(setLog, t("plugins.studio.repoMissing"));
      } catch (err) {
        if (!cancelled) appendLog(setLog, String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // 进入工作台只探测一次。t / project 变化会重建 callback，若挂在 effect 上会反复 spawn cargo/node（Windows 弹控制台）。
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

  const installEnv = useCallback(
    async (tool: EnvTool) => {
      if (installing || running) return;
      setInstalling(tool);
      setRunning(`env:${tool}`);
      try {
        const ret = await unwrapCommand(commands.pluginStudioEnvInstall(tool), { quiet: true });
        appendLog(setLog, ret.output || `${tool}: ${ret.ok ? "ok" : "fail"}`);
        await reloadEnv();
        if (ret.ok) {
          appendLog(
            setLog,
            t("plugins.studio.envInstallOk", { tool, version: ret.version ?? t("plugins.studio.envOk") }),
          );
        } else {
          appendLog(setLog, t("plugins.studio.envInstallFail", { tool }));
        }
      } catch (err) {
        appendLog(setLog, String(err));
      } finally {
        setInstalling("");
        setRunning("");
      }
    },
    [installing, running, reloadEnv, t],
  );

  const installMissing = useCallback(async () => {
    for (const tool of ENV_TOOLS) {
      if (env?.[tool]) continue;
      await installEnv(tool);
    }
  }, [env, installEnv]);

  const openFile = useCallback(
    async (projectName: string, rel: string) => {
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
    [],
  );

  const saveFile = useCallback(async () => {
    if (!project || !file) return;
    try {
      await unwrapCommand(commands.pluginStudioWriteFile(project, file, content));
      setSavedContent(content);
      appendLog(setLog, `${t("plugins.studio.saved")}: ${file}`);
    } catch (err) {
      appendLog(setLog, String(err));
    }
  }, [project, file, content, t]);

  const runOp = useCallback(
    async (op: "validate" | "pack") => {
      if (!project || running) return;
      setRunning(op);
      setArtifact("");
      setPerms([]);
      try {
      const ret = await unwrapCommand(commands.pluginStudioRun(project, op), { quiet: true });
        appendLog(setLog, ret.output);
        if (ret.success && ret.artifactPath) {
          setArtifact(ret.artifactPath);
          // 打包成功直接预读权限，进入安装确认
          try {
            const manifestJson = await unwrapCommand(commands.pluginPeekManifest(ret.artifactPath));
            const manifest = parsePluginManifest(JSON.parse(manifestJson));
            setPerms([...manifest.permissions]);
          } catch (err) {
            appendLog(setLog, String(err));
          }
        }
      } catch (err) {
        appendLog(setLog, String(err));
      } finally {
        setRunning("");
        void reloadProjects(project);
      }
    },
    [project, running, reloadProjects],
  );

  const installArtifact = useCallback(async () => {
    if (!artifact || running) return;
    setRunning("install");
    try {
      await unwrapCommand(commands.pluginInstallFromFile(artifact));
      appendLog(setLog, `${artifact} installed`);
      setArtifact("");
      setPerms([]);
    } catch (err) {
      appendLog(setLog, String(err));
    } finally {
      setRunning("");
    }
  }, [artifact, running]);

  const createProject = useCallback(async () => {
    if (!newName.trim() || running) return;
    setRunning("create");
    setCreateError(null);
    try {
      const created = await unwrapCommand(commands.pluginStudioScaffold(newName.trim(), newKind), {
        quiet: true,
      });
      appendLog(setLog, `created ${created.name} (${created.files.length} files)`);
      setNewName("");
      setNewKind("addon");
      setCreateOpen(false);
      await reloadProjects(created.name);
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setRunning("");
    }
  }, [newName, newKind, running, reloadProjects]);

  const aiScaffold = useCallback(async () => {
    if (!project || !aiDesc.trim() || running) return;
    setRunning("ai");
    try {
      const { requestAiCompletionOnce } = await import("../../lib/ai/requestAiCompletionOnce");
      const ret = await requestAiCompletionOnce({
        system: SCAFFOLD_SYSTEM,
        user: aiDesc.trim(),
        maxTokens: 2048,
      });
      if (!ret.ok) {
        appendLog(setLog, `AI scaffold failed: ${ret.reason}`);
        return;
      }
      const blocks = extractFencedBlocks(ret.content);
      if (!blocks["plugin.json"] || !blocks["ui/main.js"] || !blocks["ui/index.html"]) {
        appendLog(setLog, `${t("plugins.studio.aiFailed")}:\n${ret.content}`);
        return;
      }
      for (const [rel, body] of Object.entries(blocks)) {
        await unwrapCommand(commands.pluginStudioWriteFile(project, rel, body));
      }
      appendLog(setLog, t("plugins.studio.aiDone"));
      await openFile(project, "plugin.json");
      await runOp("validate");
    } catch (err) {
      appendLog(setLog, String(err));
    } finally {
      setRunning("");
      setAiDesc("");
    }
  }, [project, aiDesc, running, openFile, runOp, t]);

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
  }, [project, artifactUrl, changelog, repo, artifact]);

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
  }, [tokenDraft, submitPreview, project, artifactUrl, changelog, repo, artifact]);

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
  }, [project, artifactUrl, changelog, repo, artifact, t]);

  const kindOptions = PLUGIN_KINDS.map((kind) => ({
    value: kind,
    label: t(`plugins.studio.kindLabels.${kind}`),
  }));
  const missingEnv = ENV_TOOLS.filter((tool) => !env?.[tool]);
  const envBusy = installing !== "" || running.startsWith("env:");

  return (
    <div className="plugin-center plugin-studio">
      <WorkbenchPanelHeader
        tags={[{ text: project || t("plugins.studio.noProject"), emphasis: true }]}
        actions={
          <>
            <WorkbenchActionButton disabled={!project || running !== ""} onClick={() => void runOp("validate")}>
              {t("plugins.studio.validate")}
            </WorkbenchActionButton>
            <WorkbenchActionButton disabled={!project || running !== ""} onClick={() => void runOp("pack")}>
              {t("plugins.studio.pack")}
            </WorkbenchActionButton>
            <WorkbenchActionButton
              disabled={!project || running !== ""}
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
                  disabled={running !== ""}
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
                  <div key={item.name}>
                    <button
                      type="button"
                      className={`plugin-center-row${project === item.name ? " is-active" : ""}`}
                      onClick={() => {
                        setProject(item.name);
                        setFile("");
                        setContent("");
                        setSavedContent("");
                      }}
                    >
                      <span className="plugin-center-row__name">{item.name}</span>
                      <span className="plugin-center-row__meta">
                        {item.files.length} · {item.hasManifest ? "plugin.json" : t("plugins.studio.noFile")}
                      </span>
                    </button>
                    {project === item.name ? (
                      <div className="plugin-studio-files">
                        {item.files.map((rel) => (
                          <button
                            key={rel}
                            type="button"
                            className={`plugin-center-row plugin-studio-file${file === rel ? " is-active" : ""}`}
                            onClick={() => void openFile(item.name, rel)}
                          >
                            <span className="plugin-center-row__name">{rel}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </section>
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
            <p className="plugin-studio-env-hint">{t("plugins.studio.envHint")}</p>
            <div className="plugin-studio-env-list">
              {ENV_TOOLS.map((tool) => {
                const ver = env?.[tool];
                const busy = installing === tool;
                return (
                  <div key={tool} className="plugin-studio-env-row">
                    <span className="plugin-studio-env-name">{tool}</span>
                    <span className={`plugin-studio-env-ver${ver ? "" : " is-missing"}`}>
                      {busy ? t("plugins.studio.envInstalling") : ver || t("plugins.studio.envMissing")}
                    </span>
                    {ver || busy ? null : (
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
          <div className="plugin-studio-ai">
            <TextInput
              value={aiDesc}
              onChange={setAiDesc}
              placeholder={t("plugins.studio.aiPlaceholder")}
              size="sm"
              clearable
              copyable={false}
            />
            <WorkbenchActionButton
              disabled={!project || !aiDesc.trim() || running !== ""}
              onClick={() => void aiScaffold()}
            >
              {t("plugins.studio.aiGenerate")}
            </WorkbenchActionButton>
            <WorkbenchActionButton disabled={!dirty || running !== ""} onClick={() => void saveFile()}>
              {t("plugins.studio.save")}
              {dirty ? ` (${t("plugins.studio.unsaved")})` : ""}
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
                </ol>
              </div>
            )}
          </div>
          {artifact ? (
            <div className="plugin-studio-artifact">
              <div className="plugin-center-col__head">{t("plugins.studio.permsTitle")}</div>
              <p className="plugin-studio-artifact__perms">
                {perms.length === 0 ? t("plugins.install.noPermissions") : perms.join(", ")}
              </p>
              <WorkbenchActionButton disabled={running !== ""} onClick={() => void installArtifact()}>
                {t("plugins.studio.installConfirm")}
              </WorkbenchActionButton>
            </div>
          ) : null}
          <div className="plugin-studio-log">
            <div className="plugin-center-col__head">{t("plugins.studio.log")}</div>
            <LogViewer text={log} emptyText={t("plugins.studio.log")} />
          </div>
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
          disabled: !newName.trim() || running !== "",
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
            onChange={setNewKind}
            options={kindOptions}
            searchable={false}
            aria-label={t("plugins.studio.kind")}
          />
        </FormField>
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
