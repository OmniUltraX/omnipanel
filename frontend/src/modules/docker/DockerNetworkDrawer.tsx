import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import type { DockerNetworkDetail } from "../../ipc/bindings";
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

interface DockerNetworkDrawerProps {
  name: string | null;
  onClose: () => void;
  inspectNetwork: (name: string) => Promise<DockerNetworkDetail | null>;
  onRemove: (name: string) => Promise<DockerActionResult>;
}

export function DockerNetworkDrawer({ name, onClose, inspectNetwork, onRemove }: DockerNetworkDrawerProps) {
  const [detail, setDetail] = useState<DockerNetworkDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const d = await inspectNetwork(name);
        if (cancelled) return;
        setDetail(d);
        if (!d) setError("无法读取网络详情");
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name, inspectNetwork]);

  const open = Boolean(name);
  const isSystem = name === "bridge" || name === "host" || name === "none";

  return (
    <>
      <div className={`drawer-overlay${open ? " show" : ""}`} onClick={onClose} />
      <aside className={`docker-drawer${open ? " show" : ""}`} role="dialog" aria-label="网络详情" aria-hidden={!open}>
        {open && name && (
          <>
        <header className="docker-drawer-header">
          <div className="docker-drawer-title">
            <div className="docker-drawer-eyebrow">网络</div>
            <h2>{name}</h2>
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
                  <dd><code>{detail.id ? detail.id.slice(0, 12) : "-"}</code></dd>
                  <dt>驱动</dt>
                  <dd>{detail.driver || "-"}</dd>
                  <dt>范围</dt>
                  <dd>{detail.scope || "-"}</dd>
                  <dt>内部</dt>
                  <dd>{detail.internal ? "是" : "否"}</dd>
                  <dt>IPv6</dt>
                  <dd>{detail.enableIpv6 ? "启用" : "关闭"}</dd>
                  <dt>创建时间</dt>
                  <dd>{formatDockerTime(detail.createdAt)}</dd>
                </dl>
              </section>
              {detail.subnets.length > 0 && (
                <section className="docker-drawer-section">
                  <h4>IPAM 子网</h4>
                  <table className="docker-drawer-table">
                    <thead>
                      <tr>
                        <th>子网</th>
                        <th>网关</th>
                        <th>范围</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.subnets.map((s, idx) => (
                        <tr key={idx}>
                          <td><code>{s.subnet ?? "-"}</code></td>
                          <td><code>{s.gateway ?? "-"}</code></td>
                          <td><code>{s.ipRange ?? "-"}</code></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
              {detail.containers.length > 0 && (
                <section className="docker-drawer-section">
                  <h4>已连接容器 ({detail.containers.length})</h4>
                  <table className="docker-drawer-table">
                    <thead>
                      <tr>
                        <th>名称</th>
                        <th>IPv4</th>
                        <th>MAC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.containers.map((c) => (
                        <tr key={c.containerId}>
                          <td title={c.containerId}>
                            <code>{c.name || c.containerId.slice(0, 12)}</code>
                          </td>
                          <td><code>{c.ipv4Address ?? "-"}</code></td>
                          <td><code>{c.macAddress ?? "-"}</code></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
              {detail.options.length > 0 && (
                <section className="docker-drawer-section">
                  <h4>选项</h4>
                  <pre className="docker-drawer-pre">
                    {detail.options.map((l) => `${l.key} = ${l.value}`).join("\n")}
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
            disabled={!detail || isSystem}
            title={isSystem ? "系统网络不可删除" : ""}
            onClick={async () => {
              if (!detail) return;
              setConfirm({
                title: `删除网络 ${name}`,
                message: `将永久删除网络 ${name}，此操作不可恢复。`,
                confirmLabel: "确认删除",
                onConfirm: async () => {
                  setConfirm(null);
                  const r = await onRemove(name);
                  if (r.ok) onClose();
                },
              });
            }}
          >
            删除网络
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
