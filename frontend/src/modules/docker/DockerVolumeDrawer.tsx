import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import type { DockerVolumeDetail } from "../../ipc/bindings";
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

interface DockerVolumeDrawerProps {
  name: string | null;
  onClose: () => void;
  inspectVolume: (name: string) => Promise<DockerVolumeDetail | null>;
  onRemove: (name: string) => Promise<DockerActionResult>;
}

function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || n < 0) return "-";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function DockerVolumeDrawer({ name, onClose, inspectVolume, onRemove }: DockerVolumeDrawerProps) {
  const [detail, setDetail] = useState<DockerVolumeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const d = await inspectVolume(name);
        if (cancelled) return;
        setDetail(d);
        if (!d) setError("无法读取卷详情");
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name, inspectVolume]);

  const open = Boolean(name);

  return (
    <>
      <div className={`drawer-overlay${open ? " show" : ""}`} onClick={onClose} />
      <aside className={`docker-drawer${open ? " show" : ""}`} role="dialog" aria-label="卷详情" aria-hidden={!open}>
        {open && name && (
          <>
        <header className="docker-drawer-header">
          <div className="docker-drawer-title">
            <div className="docker-drawer-eyebrow">卷</div>
            <h2 title={name}>{name}</h2>
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
                  <dt>驱动</dt>
                  <dd>{detail.driver || "-"}</dd>
                  <dt>范围</dt>
                  <dd>{detail.scope || "-"}</dd>
                  <dt>挂载点</dt>
                  <dd><code>{detail.mountpoint || "-"}</code></dd>
                  <dt>创建时间</dt>
                  <dd>{formatDockerTime(detail.createdAt)}</dd>
                  <dt>占用</dt>
                  <dd>{formatBytes(detail.sizeBytes)}</dd>
                  <dt>引用数</dt>
                  <dd>{detail.referenceCount || 0}</dd>
                </dl>
              </section>
              {detail.options.length > 0 && (
                <section className="docker-drawer-section">
                  <h4>驱动选项</h4>
                  <pre className="docker-drawer-pre">
                    {detail.options.map((l) => `${l.key} = ${l.value}`).join("\n")}
                  </pre>
                </section>
              )}
              {detail.labels.length > 0 && (
                <section className="docker-drawer-section">
                  <h4>标签</h4>
                  <pre className="docker-drawer-pre">
                    {detail.labels.map((l) => `${l.key} = ${l.value}`).join("\n")}
                  </pre>
                </section>
              )}
            </>
          )}
        </div>
        <footer className="docker-drawer-footer">
          <Button
            variant="danger"
            size="sm"
            disabled={!detail}
            onClick={async () => {
              if (!detail) return;
              setConfirm({
                title: `删除卷 ${name}`,
                message: `将永久删除卷 ${name}，此操作不可恢复。`,
                confirmLabel: "确认删除",
                onConfirm: async () => {
                  setConfirm(null);
                  const r = await onRemove(name);
                  if (r.ok) onClose();
                },
              });
            }}
          >
            删除卷
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
