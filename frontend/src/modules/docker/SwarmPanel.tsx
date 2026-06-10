import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface SwarmNode {
  id: string;
  hostname: string;
  status: string;
  availability: string;
  role: string;
  engine_version: string;
  addr: string;
  labels: { key: string; value: string }[];
}

interface SwarmService {
  id: string;
  name: string;
  image: string;
  mode: string;
  replicas: number;
  running_replicas: number;
  ports: string[];
  created_at: string;
  updated_at: string;
}

interface SwarmStack {
  name: string;
  services: number;
  orchestrator: string;
  namespace: string;
}

type SwarmTab = "overview" | "nodes" | "services" | "stacks";

export function SwarmPanel({ connectionId }: { connectionId: string }) {
  const [tab, setTab] = useState<SwarmTab>("overview");
  const [nodes, setNodes] = useState<SwarmNode[]>([]);
  const [services, setServices] = useState<SwarmService[]>([]);
  const [stacks, setStacks] = useState<SwarmStack[]>([]);
  const [swarmInfo, setSwarmInfo] = useState<string>("");
  const [isInSwarm, setIsInSwarm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showCreateService, setShowCreateService] = useState(false);
  const [showDeployStack, setShowDeployStack] = useState(false);

  const loadSwarmData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const info = await invoke<string>("docker_swarm_inspect", { connectionId });
      setSwarmInfo(info);
      setIsInSwarm(true);
      const [n, s] = await Promise.all([
        invoke<SwarmNode[]>("docker_node_list", { connectionId }),
        invoke<SwarmService[]>("docker_service_list", { connectionId }),
      ]);
      setNodes(n);
      setServices(s);
      try {
        const st = await invoke<SwarmStack[]>("docker_stack_list", { connectionId });
        setStacks(st);
      } catch { setStacks([]); }
    } catch {
      setIsInSwarm(false);
      setNodes([]);
      setServices([]);
      setStacks([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { loadSwarmData(); }, [loadSwarmData]);

  const handleInitSwarm = async () => {
    setLoading(true);
    try {
      await invoke("docker_swarm_init", { connectionId, listenAddr: null, advertiseAddr: null });
      await loadSwarmData();
    } catch (e: unknown) { setError(String(e)); }
    finally { setLoading(false); }
  };

  const handleLeaveSwarm = async () => {
    if (!confirm("确定要离开 Swarm 集群？")) return;
    setLoading(true);
    try {
      await invoke("docker_swarm_leave", { connectionId, force: true });
      setIsInSwarm(false);
      setNodes([]); setServices([]); setStacks([]);
    } catch (e: unknown) { setError(String(e)); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Sub tabs */}
      <div style={{ display: "flex", gap: 4, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
        {(["overview", "nodes", "services", "stacks"] as SwarmTab[]).map((t) => (
          <button key={t} className={`btn btn-sm ${tab === t ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setTab(t)}>
            {t === "overview" ? "概览" : t === "nodes" ? "节点" : t === "services" ? "服务" : "Stack"}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {!isInSwarm ? (
          <button className="btn btn-sm btn-primary" onClick={handleInitSwarm} disabled={loading}>
            初始化 Swarm
          </button>
        ) : (
          <>
            <button className="btn btn-sm btn-ghost" onClick={() => setShowCreateService(true)}>+ 服务</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setShowDeployStack(true)}>+ Stack</button>
            <button className="btn btn-sm btn-danger" onClick={handleLeaveSwarm}>离开</button>
          </>
        )}
      </div>

      {error && <div style={{ padding: "8px 12px", color: "var(--danger)", fontSize: 12 }}>{error}</div>}

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
        {!isInSwarm ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
            <p>当前连接未加入 Swarm 集群</p>
            <button className="btn btn-primary" onClick={handleInitSwarm} disabled={loading} style={{ marginTop: 12 }}>
              初始化 Swarm
            </button>
          </div>
        ) : tab === "overview" ? (
          <div>
            <h3 style={{ marginBottom: 12 }}>Swarm 概览</h3>
            <pre style={{ background: "var(--bg-secondary)", padding: 12, borderRadius: 6, fontSize: 12, overflow: "auto", maxHeight: 400 }}>
              {swarmInfo || "加载中..."}
            </pre>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 16 }}>
              <div className="card" style={{ padding: 16, textAlign: "center" }}>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{nodes.length}</div>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>节点</div>
              </div>
              <div className="card" style={{ padding: 16, textAlign: "center" }}>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{services.length}</div>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>服务</div>
              </div>
              <div className="card" style={{ padding: 16, textAlign: "center" }}>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{stacks.length}</div>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>Stack</div>
              </div>
            </div>
          </div>
        ) : tab === "nodes" ? (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>ID</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>主机名</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>状态</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>可用性</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>角色</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>引擎版本</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.id} style={{ borderBottom: "1px solid var(--border-hover)" }}>
                  <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{n.id.slice(0, 12)}</td>
                  <td style={{ padding: "6px 8px" }}>{n.hostname}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <span className={`badge ${n.status === "ready" ? "badge-success" : "badge-warn"}`}>{n.status}</span>
                  </td>
                  <td style={{ padding: "6px 8px" }}>{n.availability}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <span className={`badge ${n.role === "manager" ? "badge-primary" : "badge-muted"}`}>{n.role}</span>
                  </td>
                  <td style={{ padding: "6px 8px" }}>{n.engine_version}</td>
                </tr>
              ))}
              {nodes.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 20, textAlign: "center", color: "var(--muted)" }}>无节点</td></tr>
              )}
            </tbody>
          </table>
        ) : tab === "services" ? (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>ID</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>名称</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>镜像</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>模式</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>副本数</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.id} style={{ borderBottom: "1px solid var(--border-hover)" }}>
                  <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{s.id.slice(0, 12)}</td>
                  <td style={{ padding: "6px 8px" }}>{s.name}</td>
                  <td style={{ padding: "6px 8px" }}>{s.image}</td>
                  <td style={{ padding: "6px 8px" }}>{s.mode}</td>
                  <td style={{ padding: "6px 8px" }}>{s.running_replicas}/{s.replicas}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <button className="btn btn-sm btn-danger" onClick={async () => {
                      if (confirm(`删除服务 ${s.name}？`)) {
                        await invoke("docker_service_remove", { connectionId, serviceId: s.id });
                        loadSwarmData();
                      }
                    }}>删除</button>
                  </td>
                </tr>
              ))}
              {services.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 20, textAlign: "center", color: "var(--muted)" }}>无服务</td></tr>
              )}
            </tbody>
          </table>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>名称</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>服务数</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {stacks.map((st) => (
                <tr key={st.name} style={{ borderBottom: "1px solid var(--border-hover)" }}>
                  <td style={{ padding: "6px 8px" }}>{st.name}</td>
                  <td style={{ padding: "6px 8px" }}>{st.services}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <button className="btn btn-sm btn-danger" onClick={async () => {
                      if (confirm(`删除 Stack ${st.name}？`)) {
                        await invoke("docker_stack_remove", { connectionId, name: st.name });
                        loadSwarmData();
                      }
                    }}>删除</button>
                  </td>
                </tr>
              ))}
              {stacks.length === 0 && (
                <tr><td colSpan={3} style={{ padding: 20, textAlign: "center", color: "var(--muted)" }}>无 Stack</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Create Service Dialog */}
      {showCreateService && (
        <CreateServiceDialog
          connectionId={connectionId}
          onClose={() => setShowCreateService(false)}
          onCreated={() => { setShowCreateService(false); loadSwarmData(); }}
        />
      )}

      {/* Deploy Stack Dialog */}
      {showDeployStack && (
        <DeployStackDialog
          connectionId={connectionId}
          onClose={() => setShowDeployStack(false)}
          onDeployed={() => { setShowDeployStack(false); loadSwarmData(); }}
        />
      )}
    </div>
  );
}

function CreateServiceDialog({ connectionId, onClose, onCreated }: { connectionId: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [replicas, setReplicas] = useState(1);
  const [ports, setPorts] = useState("");
  const [env, setEnv] = useState("");
  const [command, setCommand] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await invoke("docker_service_create", {
        connectionId,
        request: {
          name, image, replicas,
          ports: ports ? ports.split(",").map((p) => p.trim()) : [],
          env: env ? env.split(",").map((e) => e.trim()) : [],
          networks: [],
          command: command || null,
          constraints: [],
        },
      });
      onCreated();
    } catch (err: unknown) { setError(String(err)); }
    finally { setLoading(false); }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
        <h3>创建 Swarm 服务</h3>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          <input className="input" placeholder="服务名称" value={name} onChange={(e) => setName(e.target.value)} required />
          <input className="input" placeholder="镜像 (如 nginx:latest)" value={image} onChange={(e) => setImage(e.target.value)} required />
          <input className="input" type="number" placeholder="副本数" value={replicas} onChange={(e) => setReplicas(Number(e.target.value))} min={0} />
          <input className="input" placeholder="端口映射 (8080:80,9090:90)" value={ports} onChange={(e) => setPorts(e.target.value)} />
          <input className="input" placeholder="环境变量 (KEY=val,FOO=bar)" value={env} onChange={(e) => setEnv(e.target.value)} />
          <input className="input" placeholder="启动命令 (可选)" value={command} onChange={(e) => setCommand(e.target.value)} />
          {error && <div style={{ color: "var(--danger)", fontSize: 12 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? "创建中..." : "创建"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeployStackDialog({ connectionId, onClose, onDeployed }: { connectionId: string; onClose: () => void; onDeployed: () => void }) {
  const [name, setName] = useState("");
  const [compose, setCompose] = useState("version: '3'\nservices:\n  web:\n    image: nginx:latest\n    ports:\n      - '8080:80'");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await invoke("docker_stack_deploy", { connectionId, name, composeContent: compose, env: null });
      onDeployed();
    } catch (err: unknown) { setError(String(err)); }
    finally { setLoading(false); }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: 560 }}>
        <h3>部署 Stack</h3>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          <input className="input" placeholder="Stack 名称" value={name} onChange={(e) => setName(e.target.value)} required />
          <textarea className="input" placeholder="Compose YAML" value={compose} onChange={(e) => setCompose(e.target.value)}
            rows={12} style={{ fontFamily: "monospace", fontSize: 12, resize: "vertical" }} />
          {error && <div style={{ color: "var(--danger)", fontSize: 12 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? "部署中..." : "部署"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
