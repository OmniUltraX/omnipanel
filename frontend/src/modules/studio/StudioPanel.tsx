import { useCallback, useEffect, useState } from "react";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import { CodeEditor, codeEditorLanguageFromPath } from "../../components/ui/content";
import { TextInput } from "../../components/ui/form/TextInput";
import { Select } from "../../components/ui/form/Select";
import { LogViewer } from "../../components/ui/content";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { WorkbenchPanelHeader } from "../../components/ui/primitives/WorkbenchPanelHeader";
import { useI18n } from "../../i18n";
import { commands, type StudioProject } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { extractFencedBlocks } from "./scaffoldFormat";

const SCAFFOLD_KINDS = [
  "engine",
  "module",
  "cloud",
  "panel",
  "importer",
  "addon",
  "theme",
  "js-logic",
  "l3-overlay",
  "wasm-stub",
  "engine-sidecar",
];

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
  const [env, setEnv] = useState<{
    cargo?: string | null;
    node?: string | null;
    wat2wasm?: string | null;
  } | null>(null);
  const [newName, setNewName] = useState<string>("");
  const [newKind, setNewKind] = useState<string>("addon");
  const [aiDesc, setAiDesc] = useState<string>("");
  const [artifact, setArtifact] = useState<string>("");
  const [perms, setPerms] = useState<string[]>([]);

  const dirty = content !== savedContent;

  const reloadProjects = useCallback(async (select?: string) => {
    try {
      const list = await unwrapCommand(commands.pluginStudioListProjects());
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

  const reloadEnv = useCallback(async () => {
    try {
      const info = await unwrapCommand(commands.pluginStudioEnvCheck());
      setEnv(info);
      if (!info.repoRoot) appendLog(setLog, "studio.repoMissing");
    } catch (err) {
      appendLog(setLog, String(err));
    }
  }, []);

  useEffect(() => {
    void reloadProjects();
    void reloadEnv();
  }, [reloadProjects, reloadEnv]);

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
        const ret = await unwrapCommand(commands.pluginStudioRun(project, op));
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
    try {
      const created = await unwrapCommand(commands.pluginStudioScaffold(newName.trim(), newKind));
      appendLog(setLog, `created ${created.name} (${created.files.length} files)`);
      setNewName("");
      await reloadProjects(created.name);
    } catch (err) {
      appendLog(setLog, String(err));
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

  return (
    <div className="plugin-center">
      <WorkbenchPanelHeader
        label={t("routes.studio")}
        tags={[{ text: project || t("plugins.studio.noProject"), emphasis: true }]}
        actions={
          <>
            <WorkbenchActionButton disabled={!project || running !== ""} onClick={() => void runOp("validate")}>
              {t("plugins.studio.validate")}
            </WorkbenchActionButton>
            <WorkbenchActionButton disabled={!project || running !== ""} onClick={() => void runOp("pack")}>
              {t("plugins.studio.pack")}
            </WorkbenchActionButton>
          </>
        }
      />
      <div className="plugin-center-split" style={{ flex: 1, minHeight: 0 }}>
        <aside className="plugin-center-col plugin-center-col--installed">
          <div className="plugin-center-col__head">{t("plugins.studio.projects")}</div>
          <div style={{ display: "flex", gap: 4, padding: "0 8px 8px" }}>
            <TextInput
              value={newName}
              onChange={setNewName}
              placeholder={t("plugins.studio.name")}
              size="sm"
              clearable
              copyable={false}
            />
          </div>
          <div style={{ display: "flex", gap: 4, padding: "0 8px 8px" }}>
            <Select
              value={newKind}
              onChange={setNewKind}
              options={SCAFFOLD_KINDS}
              size="sm"
              aria-label={t("plugins.studio.kind")}
            />
            <WorkbenchActionButton disabled={!newName.trim() || running !== ""} onClick={() => void createProject()}>
              {t("plugins.studio.create")}
            </WorkbenchActionButton>
          </div>
          <div className="plugin-center-list">
            {projects.length === 0 ? (
              <p className="plugin-center-empty">{t("plugins.studio.emptyProjects")}</p>
            ) : (
              projects.map((p) => (
                <div key={p.name}>
                  <button
                    type="button"
                    className={`plugin-center-row${project === p.name ? " is-active" : ""}`}
                    onClick={() => {
                      setProject(p.name);
                      setFile("");
                      setContent("");
                      setSavedContent("");
                    }}
                  >
                    <span className="plugin-center-row__name">{p.name}</span>
                  </button>
                  {project === p.name && (
                    <div style={{ paddingLeft: 12 }}>
                      <div className="plugin-center-col__head">{t("plugins.studio.files")}</div>
                      {p.files.map((f) => (
                        <button
                          key={f}
                          type="button"
                          className={`plugin-center-row${file === f ? " is-active" : ""}`}
                          onClick={() => void openFile(p.name, f)}
                        >
                          <span className="plugin-center-row__name" style={{ fontFamily: "monospace", fontSize: 12 }}>
                            {f}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="plugin-center-col__head" style={{ marginTop: 8 }}>
            {t("plugins.studio.env")}
          </div>
          <div className="plugin-center-list" style={{ fontSize: 12 }}>
            {[
              ["cargo", env?.cargo],
              ["node", env?.node],
              ["wat2wasm", env?.wat2wasm],
            ].map(([name, ver]) => (
              <div key={name} className="plugin-center-row">
                <span className="plugin-center-row__name" style={{ fontFamily: "monospace" }}>
                  {name}
                </span>
                <span className="plugin-center-row__meta">
                  {ver ?? t("plugins.studio.envMissing")}
                </span>
              </div>
            ))}
          </div>
        </aside>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ display: "flex", gap: 4, padding: 8, alignItems: "center" }}>
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
          <div style={{ flex: 1, minHeight: 200 }}>
            {file ? (
              <CodeEditor
                value={content}
                onChange={setContent}
                language={codeEditorLanguageFromPath(file)}
                height="100%"
              />
            ) : (
              <p className="plugin-center-empty">{t("plugins.studio.noFile")}</p>
            )}
          </div>
          <div style={{ height: 180, borderTop: "1px solid var(--border-soft)" }}>
            <LogViewer text={log} emptyText={t("plugins.studio.log")} />
          </div>
          {artifact ? (
            <div style={{ padding: 8, borderTop: "1px solid var(--border-soft)" }}>
              <div className="plugin-center-col__head">{t("plugins.studio.permsTitle")}</div>
              <div style={{ fontSize: 12, padding: "0 8px 8px" }}>
                {perms.length === 0 ? t("plugins.install.noPermissions") : perms.join(", ")}
              </div>
              <WorkbenchActionButton disabled={running !== ""} onClick={() => void installArtifact()}>
                {t("plugins.studio.installConfirm")}
              </WorkbenchActionButton>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
