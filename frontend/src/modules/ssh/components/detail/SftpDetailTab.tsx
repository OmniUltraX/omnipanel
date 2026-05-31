import type { SshManagerContext } from "../../hooks/useSshManager";

type Props = Pick<
  SshManagerContext,
  "profile" | "openTerminal" | "openModule" | "triggerFileAction"
>;

export function SftpDetailTab({
  profile,
  openTerminal,
  openModule,
  triggerFileAction,
}: Props) {
  return (
    <div className="ssh-workbench-grid">
      <div>
        <div className="sftp-toolbar">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() =>
              triggerFileAction(
                "上传文件到主机",
                "通过 SFTP 上传当前运维文件",
                "scp ./local-file deploy@host:/var/www/app",
              )
            }
          >
            Upload
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() =>
              triggerFileAction(
                "下载主机文件",
                "下载当前目录文件做本地分析",
                "scp deploy@host:/var/www/app/config ./config.backup",
              )
            }
          >
            Download
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() =>
              triggerFileAction(
                "创建远程目录",
                "在当前目录下创建新文件夹",
                "mkdir -p /var/www/app/releases",
              )
            }
          >
            New Folder
          </button>
          <div className="sftp-path" style={{ marginLeft: "auto" }}>
            <span>/</span>
            <span className="sep">/</span>
            <span>var</span>
            <span className="sep">/</span>
            <span>www</span>
            <span className="sep">/</span>
            <span>app</span>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Size</th>
              <th>Modified</th>
            </tr>
          </thead>
          <tbody>
            {profile.files.map((file) => (
              <tr key={file.name}>
                <td>{file.name}</td>
                <td className="text-muted">{file.type}</td>
                <td className="text-muted">{file.size}</td>
                <td className="text-muted">{file.modified}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ssh-side-stack">
        <div className="panel">
          <div className="panel-header">
            <h3>文件闭环</h3>
          </div>
          <div className="panel-body action-list">
            <div className="action-row">
              <span className="action-title">配置文件</span>
              <span className="action-meta">
                适合先下载、差异比对，再联动终端做热加载验证。
              </span>
            </div>
            <div className="action-row">
              <span className="action-title">部署脚本</span>
              <span className="action-meta">
                与 Workflow 模块共用一套发布上下文，避免手工改动漂移。
              </span>
            </div>
            <div className="action-row">
              <span className="action-title">回到终端</span>
              <span className="action-meta">
                完成文件操作后建议立即进入终端执行校验命令与留痕。
              </span>
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-header">
            <h3>快捷跳转</h3>
          </div>
          <div className="panel-body ssh-module-list">
            <button
              type="button"
              className="ssh-module-item"
              onClick={() => openTerminal(profile.presets[0])}
            >
              <span className="action-title">打开排障终端</span>
              <span className="action-meta">
                把当前文件上下文带入终端工作区继续处理。
              </span>
            </button>
            <button
              type="button"
              className="ssh-module-item"
              onClick={() => openModule("/workflow")}
            >
              <span className="action-title">同步到 Workflow</span>
              <span className="action-meta">将文件改动纳入发布或巡检链路。</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
