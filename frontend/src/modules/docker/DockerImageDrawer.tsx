import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import type {
  DockerImageDetail,
  DockerImageHistoryLayer,
} from "../../ipc/bindings";
import { formatDockerTime } from "./format";
import type { DockerActionResult } from "./useDockerWorkspace";

interface ConfirmState {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  onConfirm: () => void;
}

/* eslint-disable react-hooks/set-state-in-effect -- data-fetching effect pattern */

interface DockerImageDrawerProps {
  imageId: string | null;
  onClose: () => void;
  inspectImage: (id: string) => Promise<DockerImageDetail | null>;
  imageHistory: (id: string) => Promise<DockerImageHistoryLayer[] | null>;
  onRemove: (id: string) => Promise<DockerActionResult>;
  onPrune: () => Promise<DockerActionResult>;
  onCopyId: (id: string) => void;
}

function formatBytes(n: number | null | undefined): string {
  if (!n) return "-";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function DockerImageDrawer({
  imageId,
  onClose,
  inspectImage,
  imageHistory,
  onRemove,
  onPrune,
  onCopyId,
}: DockerImageDrawerProps) {
  const [detail, setDetail] = useState<DockerImageDetail | null>(null);
  const [history, setHistory] = useState<DockerImageHistoryLayer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  useEffect(() => {
    if (!imageId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [d, h] = await Promise.all([inspectImage(imageId), imageHistory(imageId)]);
        if (cancelled) return;
        setDetail(d);
        setHistory(h);
        if (!d) setError("无法读取镜像详情");
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imageId, inspectImage, imageHistory]);

  const open = Boolean(imageId);
  const shortId = imageId && imageId.length > 12 ? imageId.slice(0, 12) : imageId ?? "";
  const repoTag = detail?.repoTags?.find((t) => t !== "<none>:<none>") ?? detail?.repoTags?.[0] ?? "<none>:<none>";

  return (
    <>
      <div className={`drawer-overlay${open ? " show" : ""}`} onClick={onClose} />
      <aside className={`docker-drawer${open ? " show" : ""}`} role="dialog" aria-label="镜像详情" aria-hidden={!open}>
        {open && (
          <>
        <header className="docker-drawer-header">
          <div className="docker-drawer-title">
            <div className="docker-drawer-eyebrow">镜像</div>
            <h2 title={repoTag}>{repoTag}</h2>
          </div>
          <Button variant="icon" onClick={onClose} title="关闭">×</Button>
        </header>
        <div className="docker-drawer-body">
          {loading && <div className="docker-empty">加载中…</div>}
          {error && <div className="docker-empty text-danger">{error}</div>}
          {detail && (
            <>
              <section className="docker-drawer-section">
                <h4>基础</h4>
                <dl className="drawer-kv">
                  <dt>ID</dt>
                  <dd>
                    <code className="docker-drawer-code" onClick={() => onCopyId(detail.id)} title="点击复制">
                      {shortId}
                    </code>
                  </dd>
                  <dt>大小</dt>
                  <dd>{formatBytes(detail.sizeBytes)}</dd>
                  <dt>创建时间</dt>
                  <dd>{formatDockerTime(detail.createdAt)}</dd>
                  <dt>架构</dt>
                  <dd>{detail.architecture ?? "-"}</dd>
                  <dt>OS</dt>
                  <dd>{detail.os ?? "-"}</dd>
                  <dt>作者</dt>
                  <dd>{detail.author ?? "-"}</dd>
                  <dt>标签</dt>
                  <dd>
                    {detail.repoTags.length > 0
                      ? detail.repoTags.map((t) => <span key={t} className="docker-drawer-tag">{t}</span>)
                      : "-"}
                  </dd>
                </dl>
              </section>
              <section className="docker-drawer-section">
                <h4>构建配置</h4>
                <dl className="drawer-kv">
                  <dt>入口</dt>
                  <dd><code>{detail.config.entrypoint ?? "-"}</code></dd>
                  <dt>命令</dt>
                  <dd><code>{detail.config.cmd ?? "-"}</code></dd>
                  <dt>工作目录</dt>
                  <dd>{detail.config.workingDir ?? "-"}</dd>
                  <dt>用户</dt>
                  <dd>{detail.config.user ?? "-"}</dd>
                </dl>
                {detail.config.env.length > 0 && (
                  <details className="docker-drawer-details">
                    <summary>环境变量 ({detail.config.env.length})</summary>
                    <pre className="docker-drawer-pre">{detail.config.env.join("\n")}</pre>
                  </details>
                )}
                {detail.config.exposedPorts.length > 0 && (
                  <details className="docker-drawer-details">
                    <summary>暴露端口 ({detail.config.exposedPorts.length})</summary>
                    <pre className="docker-drawer-pre">{detail.config.exposedPorts.join("\n")}</pre>
                  </details>
                )}
                {detail.config.volumes.length > 0 && (
                  <details className="docker-drawer-details">
                    <summary>卷 ({detail.config.volumes.length})</summary>
                    <pre className="docker-drawer-pre">{detail.config.volumes.join("\n")}</pre>
                  </details>
                )}
                {detail.config.labels.length > 0 && (
                  <details className="docker-drawer-details">
                    <summary>标签 ({detail.config.labels.length})</summary>
                    <pre className="docker-drawer-pre">
                      {detail.config.labels.map((l) => `${l.key} = ${l.value}`).join("\n")}
                    </pre>
                  </details>
                )}
              </section>
              {history && history.length > 0 && (
                <section className="docker-drawer-section">
                  <h4>历史层 ({history.length})</h4>
                  <ol className="docker-drawer-history">
                    {history.map((layer, idx) => (
                      <li key={`${layer.id}-${idx}`}>
                        <div className="docker-drawer-history-meta">
                          <code>{layer.id ? layer.id.slice(0, 12) : "<missing>"}</code>
                          <span className="text-muted text-sm">{formatBytes(layer.sizeBytes)}</span>
                        </div>
                        <div className="docker-drawer-history-cmd">
                          {layer.createdBy || "<no command>"}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </>
          )}
        </div>
        <footer className="docker-drawer-footer">
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              const r = await onPrune();
              if (r.ok) onClose();
            }}
          >
            清理悬空
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={!detail}
            onClick={async () => {
              if (!detail) return;
              setConfirm({
                title: `删除镜像 ${shortId}`,
                message: `将永久删除镜像 ${shortId}（含 tag），此操作不可恢复。`,
                confirmLabel: "确认删除",
                onConfirm: async () => {
                  setConfirm(null);
                  const r = await onRemove(detail.id);
                  if (r.ok) onClose();
                },
              });
            }}
          >
            删除
          </Button>
        </footer>
          </>
        )}
      </aside>
      {confirm && (
        <ConfirmModal confirm={confirm} onCancel={() => setConfirm(null)} />
      )}
    </>
  );
}

function ConfirmModal({ confirm, onCancel }: { confirm: ConfirmState; onCancel: () => void }) {
  return (
    <>
      <div className="drawer-overlay show" onClick={onCancel} />
      <div className="confirm-modal">
        <h3>{confirm.title}</h3>
        <p className="text-sm">{confirm.message}</p>
        {confirm.detail && <p className="text-muted text-xs">{confirm.detail}</p>}
        <div className="flex gap-2" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <Button variant="secondary" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="danger" size="sm" onClick={confirm.onConfirm}>{confirm.confirmLabel}</Button>
        </div>
      </div>
    </>
  );
}
