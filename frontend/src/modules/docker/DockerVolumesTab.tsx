import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { FormDialog } from "../../components/ui/FormDialog";
import type { DockerVolumeSummary, DockerCreateVolumeRequest } from "../../ipc/bindings";
import type { DockerActionResult } from "./useDockerWorkspace";
import { TrashIcon } from "./icons";

interface ConfirmState {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  onConfirm: () => void;
}

interface DockerVolumesTabProps {
  volumes: DockerVolumeSummary[];
  canManage: boolean;
  onRefresh: () => Promise<void>;
  onCreate: (req: DockerCreateVolumeRequest) => Promise<DockerActionResult>;
  onRemove: (name: string) => Promise<DockerActionResult>;
  onPrune: () => Promise<DockerActionResult>;
  onInspect: (name: string) => void;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function DockerVolumesTab({ volumes, canManage, onRefresh, onCreate, onRemove, onPrune, onInspect }: DockerVolumesTabProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("local");
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  return (
    <div className="container-list">
      <div className="docker-filters">
        <span className="text-muted text-sm">{volumes.length} 个卷</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <Button variant="secondary" size="sm" onClick={onRefresh}>刷新</Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!canManage}
            onClick={async () => {
              setConfirm({
                title: "清理未使用的卷",
                message: "将删除所有未使用的卷以释放磁盘空间。",
                confirmLabel: "确认清理",
                onConfirm: async () => {
                  setConfirm(null);
                  await onPrune();
                },
              });
            }}
          >
            清理
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canManage}
            onClick={() => setShowCreate(true)}
          >
            新建卷
          </Button>
        </div>
      </div>
      <div className="list-header volume-row">
        <span>名称</span>
        <span>驱动</span>
        <span>挂载点</span>
        <span>大小</span>
        <span>状态</span>
        <span></span>
      </div>
      {volumes.length === 0 ? (
        <div className="docker-empty" style={{ minHeight: 120 }}>暂无卷</div>
      ) : (
          volumes.map((v) => (
            <div
              key={v.name}
              className="container-card volume-row"
              onClick={() => onInspect(v.name)}
            >
              <div className="container-title">{v.name}</div>
              <div className="text-sm">{v.driver}</div>
              <div className="text-sm text-muted" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{v.mountpoint}</div>
              <div className="text-sm">{formatBytes(v.sizeBytes)}</div>
              <div className="text-sm">{v.inUse ? <span className="badge badge-success">使用中</span> : <span className="badge badge-muted">空闲</span>}</div>
              <div className="container-actions" onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="icon"
                  className="text-danger"
                  title="删除卷"
                  disabled={!canManage}
                  onClick={() => {
                  setConfirm({
                    title: `删除卷 ${v.name}`,
                    message: `将永久删除卷 ${v.name}，此操作不可恢复。`,
                    confirmLabel: "确认删除",
                    onConfirm: async () => {
                      setConfirm(null);
                      await onRemove(v.name);
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
        title="新建卷"
        onCancel={() => setShowCreate(false)}
        primaryAction={{
          label: "创建",
          disabled: !name.trim(),
          onClick: () => {
            void (async () => {
              const r = await onCreate({
                name: name.trim(),
                driver: driver.trim() || null,
                labels: [],
              });
              if (r.ok) {
                setShowCreate(false);
                setName("");
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
          <input className="input" value={driver} onChange={(e) => setDriver(e.target.value)} style={{ width: "100%" }} />
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
