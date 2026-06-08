import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { FormDialog } from "../../components/ui/FormDialog";
import { Select } from "../../components/ui/Select";
import type { DockerNetworkSummary, DockerCreateNetworkRequest } from "../../ipc/bindings";
import type { DockerActionResult } from "./useDockerWorkspace";
import { formatDockerTime } from "./format";
import { TrashIcon } from "./icons";

interface ConfirmState {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  onConfirm: () => void;
}

interface DockerNetworksTabProps {
  networks: DockerNetworkSummary[];
  canManage: boolean;
  onRefresh: () => Promise<void>;
  onCreate: (req: DockerCreateNetworkRequest) => Promise<DockerActionResult>;
  onRemove: (name: string) => Promise<DockerActionResult>;
  onInspect: (name: string) => void;
}

export function DockerNetworksTab({ networks, canManage, onRefresh, onCreate, onRemove, onInspect }: DockerNetworksTabProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("bridge");
  const [internal, setInternal] = useState(false);
  const [subnet, setSubnet] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  return (
    <div className="container-list">
      <div className="docker-filters">
        <span className="text-muted text-sm">{networks.length} 个网络</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <Button variant="secondary" size="sm" onClick={onRefresh}>刷新</Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canManage}
            onClick={() => setShowCreate(true)}
          >
            新建网络
          </Button>
        </div>
      </div>
      <div className="list-header network-row">
        <span>名称</span>
        <span>驱动</span>
        <span>范围</span>
        <span>内部</span>
        <span>创建时间</span>
        <span></span>
      </div>
      {networks.length === 0 ? (
        <div className="docker-empty" style={{ minHeight: 120 }}>暂无网络</div>
      ) : (
          networks.map((n) => (
            <div
              key={n.id}
              className="container-card network-row"
              onClick={() => onInspect(n.name)}
            >
              <div className="container-title">{n.name}</div>
              <div className="text-sm">{n.driver}</div>
              <div className="text-sm text-muted">{n.scope}</div>
              <div className="text-sm">{n.internal ? "是" : "否"}</div>
              <div className="text-sm text-muted">{formatDockerTime(n.createdAt)}</div>
              <div className="container-actions" onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="icon"
                  className="text-danger"
                  title="删除网络"
                  disabled={!canManage || n.name === "bridge" || n.name === "host" || n.name === "none"}
                  onClick={() => {
                    setConfirm({
                      title: `删除网络 ${n.name}`,
                      message: `将永久删除网络 ${n.name}，此操作不可恢复。`,
                      confirmLabel: "确认删除",
                      onConfirm: async () => {
                        setConfirm(null);
                        await onRemove(n.name);
                      },
                    });
                  }}
                >
                  <TrashIcon />
                </Button>
              </div>
            </div>
          ))
      )}

      <FormDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="新建网络"
        onCancel={() => setShowCreate(false)}
        primaryAction={{
          label: "创建",
          disabled: !name.trim(),
          onClick: () => {
            void (async () => {
              const r = await onCreate({
                name: name.trim(),
                driver: driver.trim() || null,
                internal,
                subnet: subnet.trim() || null,
              });
              if (r.ok) {
                setShowCreate(false);
                setName("");
                setSubnet("");
              }
            })();
          },
        }}
      >
        <div className="form-field">
          <label className="form-label">名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} />
        </div>
        <div className="form-field">
          <label className="form-label">驱动</label>
          <Select
            className="input"
            value={driver}
            onChange={setDriver}
            style={{ width: "100%" }}
            searchable={false}
            options={["bridge", "overlay", "macvlan"]}
          />
        </div>
        <div className="form-field">
          <label className="form-label">子网（CIDR，可选）</label>
          <input className="input" value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="172.20.0.0/16" style={{ width: "100%" }} />
        </div>
        <div className="form-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input id="net-internal" type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
          <label htmlFor="net-internal" className="form-label" style={{ marginBottom: 0 }}>内部网络（无外网）</label>
        </div>
      </FormDialog>
      {confirm && (
        <ConfirmModal confirm={confirm} onCancel={() => setConfirm(null)} />
      )}
    </div>
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
