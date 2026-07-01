import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { FormDialog } from "../../components/ui/FormDialog";
import { TextInput } from "../../components/ui/TextInput";
import type { DockerImageProgress } from "./useDockerWorkspace";

interface ImageActionBarProps {
  canManage: boolean;
  onPull: (image: string, onProgress?: (p: DockerImageProgress) => void) => Promise<{ ok: boolean; message?: string }>;
  onBuild: (
    contextDir: string,
    tag: string,
    dockerfile: string | null,
    onProgress?: (p: DockerImageProgress) => void
  ) => Promise<{ ok: boolean; message?: string }>;
  onMessage: (msg: string, kind?: "ok" | "err") => void;
}

type DialogKind = "pull" | "build" | null;

export function ImageActionBar({ canManage, onPull, onBuild, onMessage }: ImageActionBarProps) {
  const [dlg, setDlg] = useState<DialogKind>(null);
  const [pullImage, setPullImage] = useState("nginx:latest");
  const [ctxDir, setCtxDir] = useState("");
  const [tag, setTag] = useState("myapp:latest");
  const [dockerfile, setDockerfile] = useState("Dockerfile");
  const [progress, setProgress] = useState<DockerImageProgress[]>([]);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setDlg(null);
    setProgress([]);
    setBusy(false);
  };

  const showProgress = (p: DockerImageProgress) => {
    setProgress((prev) => [...prev, p].slice(-50));
  };

  const handlePull = async () => {
    if (!pullImage.trim()) return;
    setBusy(true);
    setProgress([]);
    const r = await onPull(pullImage.trim(), showProgress);
    onMessage(r.message ?? (r.ok ? "完成" : "失败"), r.ok ? "ok" : "err");
    setBusy(false);
    if (r.ok) setTimeout(close, 600);
  };

  const handleBuild = async () => {
    if (!ctxDir.trim() || !tag.trim()) return;
    setBusy(true);
    setProgress([]);
    const r = await onBuild(ctxDir.trim(), tag.trim(), dockerfile.trim() || null, showProgress);
    onMessage(r.message ?? (r.ok ? "完成" : "失败"), r.ok ? "ok" : "err");
    setBusy(false);
    if (r.ok) setTimeout(close, 1200);
  };

  return (
    <>
      <Button variant="secondary" size="sm" disabled={!canManage} onClick={() => setDlg("pull")}>
        拉取镜像
      </Button>
      <Button variant="secondary" size="sm" disabled={!canManage} onClick={() => setDlg("build")}>
        构建镜像
      </Button>
      <FormDialog
        open={!!dlg}
        onClose={close}
        title={dlg === "pull" ? "拉取镜像" : "构建镜像"}
        onCancel={close}
        cancelDisabled={busy}
        primaryAction={{
          label: busy ? "执行中…" : "执行",
          disabled: busy,
          onClick: () => {
            if (dlg === "pull") void handlePull();
            else if (dlg === "build") void handleBuild();
          },
        }}
      >
            {dlg === "pull" && (
              <div className="form-field">
                <label className="form-label">镜像名</label>
                <TextInput
                  value={pullImage}
                  onChange={setPullImage}
                  placeholder="nginx:latest"
                  style={{ width: "100%" }}
                />
              </div>
            )}
            {dlg === "build" && (
              <>
                <div className="form-field">
                  <label className="form-label">构建上下文目录（绝对路径）</label>
                  <TextInput
                    value={ctxDir}
                    onChange={setCtxDir}
                    placeholder="C:\Users\you\myapp"
                    style={{ width: "100%" }}
                  />
                </div>
                <div className="form-field">
                  <label className="form-label">目标 tag</label>
                  <TextInput
                    value={tag}
                    onChange={setTag}
                    placeholder="myapp:v1"
                    style={{ width: "100%" }}
                  />
                </div>
                <div className="form-field">
                  <label className="form-label">Dockerfile（相对 context_dir）</label>
                  <TextInput
                    value={dockerfile}
                    onChange={setDockerfile}
                    placeholder="Dockerfile"
                    style={{ width: "100%" }}
                  />
                </div>
              </>
            )}
            {progress.length > 0 && (
              <div className="docker-progress" style={{ marginTop: 12, maxHeight: 200, overflow: "auto" }}>
                {progress.slice(-15).map((p, i) => (
                  <div key={i} className="text-xs text-muted">
                    <span>{p.status}</span>
                    {p.detail && <span> · {p.detail}</span>}
                  </div>
                ))}
              </div>
            )}
      </FormDialog>
    </>
  );
}
