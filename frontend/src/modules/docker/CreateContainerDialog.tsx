import { useCallback, useEffect, useState } from "react";
import { FormDialog } from "../../components/ui/FormDialog";
import { Select } from "../../components/ui/Select";
import { commands } from "../../ipc/bindings";
import type { DockerCreateContainerRequest } from "../../ipc/bindings";

interface Props {
  open: boolean;
  connectionId: string | null;
  onClose: () => void;
  onCreated?: () => void;
}

export function CreateContainerDialog({ open, connectionId, onClose, onCreated }: Props) {
  const [image, setImage] = useState("");
  const [name, setName] = useState("");
  const [ports, setPorts] = useState<string[]>([]);
  const [volumes, setVolumes] = useState<string[]>([]);
  const [env, setEnv] = useState<string[]>([]);
  const [network, setNetwork] = useState("");
  const [cmd, setCmd] = useState("");
  const [restartPolicy, setRestartPolicy] = useState("no");
  const [autoRemove, setAutoRemove] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dynamic field helpers
  const [newPort, setNewPort] = useState("");
  const [newVolume, setNewVolume] = useState("");
  const [newEnv, setNewEnv] = useState("");

  useEffect(() => {
    if (!open) {
      setImage("");
      setName("");
      setPorts([]);
      setVolumes([]);
      setEnv([]);
      setNetwork("");
      setCmd("");
      setRestartPolicy("no");
      setAutoRemove(false);
      setSaving(false);
      setError(null);
    }
  }, [open]);

  const addPort = useCallback(() => {
    if (newPort.trim() && !ports.includes(newPort.trim())) {
      setPorts((p) => [...p, newPort.trim()]);
      setNewPort("");
    }
  }, [newPort, ports]);

  const addVolume = useCallback(() => {
    if (newVolume.trim() && !volumes.includes(newVolume.trim())) {
      setVolumes((v) => [...v, newVolume.trim()]);
      setNewVolume("");
    }
  }, [newVolume, volumes]);

  const addEnv = useCallback(() => {
    if (newEnv.trim() && !env.includes(newEnv.trim())) {
      setEnv((e) => [...e, newEnv.trim()]);
      setNewEnv("");
    }
  }, [newEnv, env]);

  const handleSubmit = async () => {
    if (!image.trim()) {
      setError("镜像名不能为空");
      return;
    }
    if (!connectionId) {
      setError("未选择连接");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const req: DockerCreateContainerRequest = {
        image: image.trim(),
        name: name.trim() || null,
        ports,
        volumes,
        env,
        network: network.trim() || null,
        cmd: cmd.trim() ? cmd.trim().split(/\s+/) : null,
        restartPolicy,
        autoRemove,
      };
      const res = await commands.dockerCreateContainer(connectionId, req);
      if (res.status === "ok") {
        onCreated?.();
        onClose();
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="创建容器"
      onCancel={onClose}
      cancelDisabled={saving}
      primaryAction={{
        label: saving ? "创建中…" : "创建",
        disabled: saving || !connectionId,
        onClick: () => void handleSubmit(),
      }}
    >
          {error && <div className="form-error" style={{ marginBottom: 8 }}>{error}</div>}

          <div className="form-field">
            <label className="form-label">镜像名 <span className="text-danger">*</span></label>
            <input className="input" placeholder="nginx:latest" value={image} onChange={(e) => setImage(e.target.value)} style={{ width: "100%" }} />
          </div>

          <div className="form-field">
            <label className="form-label">容器名</label>
            <input className="input" placeholder="留空自动生成" value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} />
          </div>

          {/* Ports */}
          <div className="form-field">
            <label className="form-label">端口映射</label>
            {ports.map((p, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                <code className="text-sm" style={{ flex: 1 }}>{p}</code>
                <button className="btn-icon text-danger" onClick={() => setPorts((arr) => arr.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <div style={{ display: "flex", gap: 4 }}>
              <input className="input input-sm" placeholder="8080:80/tcp" value={newPort} onChange={(e) => setNewPort(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addPort())} style={{ flex: 1 }} />
              <button className="btn btn-secondary btn-sm" onClick={addPort}>+</button>
            </div>
          </div>

          {/* Volumes */}
          <div className="form-field">
            <label className="form-label">卷挂载</label>
            {volumes.map((v, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                <code className="text-sm" style={{ flex: 1 }}>{v}</code>
                <button className="btn-icon text-danger" onClick={() => setVolumes((arr) => arr.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <div style={{ display: "flex", gap: 4 }}>
              <input className="input input-sm" placeholder="/host/path:/container/path" value={newVolume} onChange={(e) => setNewVolume(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addVolume())} style={{ flex: 1 }} />
              <button className="btn btn-secondary btn-sm" onClick={addVolume}>+</button>
            </div>
          </div>

          {/* Env */}
          <div className="form-field">
            <label className="form-label">环境变量</label>
            {env.map((e, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                <code className="text-sm" style={{ flex: 1 }}>{e}</code>
                <button className="btn-icon text-danger" onClick={() => setEnv((arr) => arr.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <div style={{ display: "flex", gap: 4 }}>
              <input className="input input-sm" placeholder="KEY=VALUE" value={newEnv} onChange={(e) => setNewEnv(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addEnv())} style={{ flex: 1 }} />
              <button className="btn btn-secondary btn-sm" onClick={addEnv}>+</button>
            </div>
          </div>

          <div className="form-field">
            <label className="form-label">网络</label>
            <input className="input" placeholder="留空使用默认" value={network} onChange={(e) => setNetwork(e.target.value)} style={{ width: "100%" }} />
          </div>

          <div className="form-field">
            <label className="form-label">启动命令</label>
            <input className="input" placeholder="留空使用镜像默认命令" value={cmd} onChange={(e) => setCmd(e.target.value)} style={{ width: "100%" }} />
          </div>

          <div className="form-field">
            <label className="form-label">重启策略</label>
            <Select
              className="input"
              value={restartPolicy}
              onChange={setRestartPolicy}
              style={{ width: "100%" }}
              searchable={false}
              options={["no", "always", "unless-stopped", "on-failure"]}
            />
          </div>

          <div className="form-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={autoRemove} onChange={(e) => setAutoRemove(e.target.checked)} />
            <label className="form-label" style={{ margin: 0 }}>自动删除（--rm）</label>
          </div>
    </FormDialog>
  );
}
