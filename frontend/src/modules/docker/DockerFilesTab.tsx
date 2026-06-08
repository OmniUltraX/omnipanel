import { useState } from "react";
import { Select } from "../../components/ui/Select";
import type { DockerContainerSummary, DockerFileEntry } from "../../ipc/bindings";

interface DockerFilesTabProps {
  containers: DockerContainerSummary[];
  files: DockerFileEntry[];
  filePath: string;
  fileContainerId: string | null;
  onPickContainer: (id: string) => Promise<void>;
  onEnter: (entry: DockerFileEntry) => Promise<void>;
  onNavigatePath?: (path: string) => void;
}

function Breadcrumb({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const parts = path.split("/").filter(Boolean);
  return (
    <div className="docker-breadcrumb">
      <span className="docker-breadcrumb-item" onClick={() => onNavigate("/")}>/</span>
      {parts.map((part, i) => {
        const subPath = "/" + parts.slice(0, i + 1).join("/");
        return (
          <span key={i} className="docker-breadcrumb-segment">
            <span className="docker-breadcrumb-sep">/</span>
            <span className="docker-breadcrumb-item" onClick={() => onNavigate(subPath)}>{part}</span>
          </span>
        );
      })}
    </div>
  );
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function DockerFilesTab({ containers, files, filePath, fileContainerId, onPickContainer, onEnter, onNavigatePath }: DockerFilesTabProps) {
  const [selectedCid, setSelectedCid] = useState<string | null>(fileContainerId);

  return (
    <div className="docker-files-tab">
      <div className="docker-filters">
        <Select
          className="input"
          value={selectedCid ?? ""}
          onChange={(v) => {
            setSelectedCid(v || null);
            if (v) void onPickContainer(v);
          }}
          style={{ minWidth: 220 }}
          placeholder="选择容器…"
          searchable={containers.length >= 8}
          options={[
            { value: "", label: "选择容器…" },
            ...containers.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        {onNavigatePath ? (
          <Breadcrumb path={filePath} onNavigate={onNavigatePath} />
        ) : (
          <span className="text-muted text-sm" style={{ marginLeft: 12 }}>路径：{filePath}</span>
        )}
      </div>
      {!fileContainerId ? (
        <div className="docker-empty" style={{ minHeight: 120 }}>请先选择一个容器</div>
      ) : files.length === 0 ? (
        <div className="docker-empty" style={{ minHeight: 120 }}>空目录</div>
      ) : (
        <div className="container-list">
          <div className="list-header file-row">
            <span>名称</span>
            <span>大小</span>
            <span>权限</span>
            <span>类型</span>
          </div>
          {files.map((f) => (
            <div
              key={f.path}
              className="container-card file-row"
              style={{ cursor: "pointer" }}
              onClick={() => void onEnter(f)}
            >
              <div className="container-title">{f.isDir ? "📁" : f.isSymlink ? "🔗" : "📄"} {f.name}</div>
              <div className="text-sm text-muted">{f.isDir ? "-" : formatBytes(f.sizeBytes)}</div>
              <div className="text-sm text-muted">{(f.mode & 0o7777).toString(8).padStart(4, "0")}</div>
              <div className="text-sm text-muted">{f.isDir ? "目录" : f.isSymlink ? "符号链接" : "文件"}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
