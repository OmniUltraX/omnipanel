import { useState } from "react";
import { Button } from "../../components/ui/Button";
import type { DockerComposeProject } from "../../ipc/bindings";
import type { DockerActionResult } from "./useDockerWorkspace";
import type { DockerComposeAction } from "../../ipc/bindings";

interface DockerComposeDrawerProps {
  project: DockerComposeProject | null;
  onClose: () => void;
  onAction: (action: DockerComposeAction, project: DockerComposeProject) => Promise<DockerActionResult>;
}

type DrawerTab = "info" | "edit";

export function DockerComposeDrawer({ project, onClose, onAction }: DockerComposeDrawerProps) {
  const [busy, setBusy] = useState<DockerComposeAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("info");
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  const open = Boolean(project);

  const run = async (action: DockerComposeAction) => {
    if (!project) return;
    setBusy(action);
    setMessage(null);
    const r = await onAction(action, project);
    setBusy(null);
    setMessage(r.message ?? null);
  };

  const handleSaveAndDeploy = async () => {
    if (!project) return;
    setSaving(true);
    setMessage(null);
    const r = await onAction("up", project);
    setSaving(false);
    setMessage(r.message ?? (r.ok ? "已保存并重新部署" : "部署失败"));
  };

  return (
    <>
      <div className={`drawer-overlay${open ? " show" : ""}`} onClick={onClose} />
      <aside className={`docker-drawer${open ? " show" : ""}`} role="dialog" aria-label="Compose 项目详情" aria-hidden={!open}>
        {open && project && (
          <>
        <header className="docker-drawer-header">
          <div className="docker-drawer-title">
            <div className="docker-drawer-eyebrow">Compose</div>
            <h2 title={project.name}>{project.name}</h2>
          </div>
          <Button variant="icon" onClick={onClose} title="关闭">×</Button>
        </header>

        <div className="drawer-subtabs" style={{ padding: "0 16px" }}>
          <button className={`subtab${drawerTab === "info" ? " active" : ""}`} onClick={() => setDrawerTab("info")}>详情</button>
          <button className={`subtab${drawerTab === "edit" ? " active" : ""}`} onClick={() => {
            setDrawerTab("edit");
            // Pre-fill with project info if not yet edited
            if (!editContent) {
              setEditContent(`# ${project.name}\n# Working dir: ${project.workingDir ?? "N/A"}\n# Config: ${project.configFiles ?? "N/A"}\n\n# Paste your docker-compose.yml content here\n`);
            }
          }}>编辑配置</button>
        </div>

        <div className="docker-drawer-body">
          {drawerTab === "info" && (
            <>
              <section className="docker-drawer-section">
                <h4>基础</h4>
                <dl className="drawer-kv">
                  <dt>项目名</dt>
                  <dd><code>{project.name}</code></dd>
                  <dt>工作目录</dt>
                  <dd><code>{project.workingDir ?? "-"}</code></dd>
                  <dt>Compose 文件</dt>
                  <dd><code>{project.configFiles ?? "-"}</code></dd>
                  <dt>服务</dt>
                  <dd>{project.serviceCount}</dd>
                  <dt>容器</dt>
                  <dd>
                    {project.containerCount}
                    {project.runningContainerCount > 0 && (
                      <span className="text-muted"> · 运行 {project.runningContainerCount}</span>
                    )}
                  </dd>
                </dl>
              </section>
              {project.services.length > 0 && (
                <section className="docker-drawer-section">
                  <h4>服务 ({project.services.length})</h4>
                  <table className="docker-drawer-table">
                    <thead>
                      <tr>
                        <th>名称</th>
                        <th>镜像</th>
                        <th>容器</th>
                      </tr>
                    </thead>
                    <tbody>
                      {project.services.map((s) => (
                        <tr key={s.name}>
                          <td><code>{s.name}</code></td>
                          <td><code className="text-muted">{s.image || "-"}</code></td>
                          <td>
                            {s.containerCount}
                            {s.runningContainerCount > 0 && (
                              <span className="text-success"> · {s.runningContainerCount} 运行</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
            </>
          )}

          {drawerTab === "edit" && (
            <section className="docker-drawer-section">
              <h4>编辑 docker-compose.yml</h4>
              <textarea
                className="input"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={20}
                style={{
                  width: "100%",
                  resize: "vertical",
                  fontFamily: "monospace",
                  fontSize: 12,
                  lineHeight: 1.5,
                  background: "var(--bg-input, #181825)",
                  color: "var(--fg, #cdd6f4)",
                  border: "1px solid var(--border, #313244)",
                  borderRadius: "var(--r-sm, 4px)",
                  padding: 8,
                }}
                spellCheck={false}
              />
              <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={saving || busy !== null}
                  onClick={handleSaveAndDeploy}
                >
                  {saving ? "保存并部署中…" : "保存并重新部署 (Up)"}
                </button>
              </div>
            </section>
          )}

          {message && (
            <div className={`docker-drawer-msg ${message.startsWith("已") ? "ok" : "err"}`}>
              {message}
            </div>
          )}
        </div>
        <footer className="docker-drawer-footer">
          <Button
            variant="primary"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run("up")}
          >
            {busy === "up" ? "启动中…" : "Up"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run("restart")}
          >
            {busy === "restart" ? "重启中…" : "Restart"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run("pull")}
          >
            {busy === "pull" ? "拉取中…" : "Pull"}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run("down")}
          >
            {busy === "down" ? "停止中…" : "Down"}
          </Button>
        </footer>
          </>
        )}
      </aside>
    </>
  );
}
