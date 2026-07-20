import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { CodeEditor } from "../../../components/ui/content/CodeEditor";
import { SubWindow } from "../../../components/ui/window";
import { useI18n } from "../../../i18n";
import { commands, type DockerCreateContainerRequest } from "../../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../../ipc/result";
import { showToast } from "../../../stores/toastStore";
import { runDockerContainerAction } from "../dockerContainerActions";

export interface DockerCreateContainerSubWindowProps {
  open: boolean;
  connectionId: string;
  onClose: () => void;
  onCreated: () => void;
}

const DEFAULT_CREATE_CONTAINER_JSON = `{
  "image": "nginx:latest",
  "name": null,
  "ports": ["8080:80"],
  "volumes": [],
  "env": [],
  "network": null,
  "cmd": null,
  "restartPolicy": "unless-stopped",
  "autoRemove": false
}
`;

function parseCreateContainerRequest(raw: string): DockerCreateContainerRequest {
  const parsed = JSON.parse(raw) as Partial<DockerCreateContainerRequest>;
  const image = typeof parsed.image === "string" ? parsed.image.trim() : "";
  if (!image) {
    throw new Error("image is required");
  }
  return {
    image,
    name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null,
    ports: Array.isArray(parsed.ports) ? parsed.ports.map(String) : [],
    volumes: Array.isArray(parsed.volumes) ? parsed.volumes.map(String) : [],
    env: Array.isArray(parsed.env) ? parsed.env.map(String) : [],
    network:
      typeof parsed.network === "string" && parsed.network.trim() ? parsed.network.trim() : null,
    cmd: Array.isArray(parsed.cmd) ? parsed.cmd.map(String) : null,
    restartPolicy:
      typeof parsed.restartPolicy === "string" && parsed.restartPolicy.trim()
        ? parsed.restartPolicy.trim()
        : null,
    autoRemove: Boolean(parsed.autoRemove),
  };
}

export function DockerCreateContainerSubWindow({
  open,
  connectionId,
  onClose,
  onCreated,
}: DockerCreateContainerSubWindowProps) {
  const { t } = useI18n();
  const [jsonText, setJsonText] = useState(DEFAULT_CREATE_CONTAINER_JSON);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setJsonText(DEFAULT_CREATE_CONTAINER_JSON);
    setError(null);
    setRunning(false);
  }, [open]);

  const handleRun = useCallback(() => {
    void (async () => {
      setError(null);
      setRunning(true);
      try {
        let request: DockerCreateContainerRequest;
        try {
          request = parseCreateContainerRequest(jsonText);
        } catch (e) {
          throw new Error(
            e instanceof Error && e.message === "image is required"
              ? t("docker.dockPanel.createContainer.imageRequired")
              : t("docker.dockPanel.createContainer.invalidJson"),
          );
        }
        const containerId = await unwrapCommand(
          commands.dockerCreateContainer(connectionId, request),
        );
        await runDockerContainerAction(connectionId, containerId, "start");
        showToast(t("docker.dockPanel.createContainer.success"));
        onCreated();
        onClose();
      } catch (e) {
        setError(formatIpcError(e) || String(e));
      } finally {
        setRunning(false);
      }
    })();
  }, [connectionId, jsonText, onClose, onCreated, t]);

  return (
    <SubWindow
      open={open}
      title={t("docker.dockPanel.createContainer.title")}
      onClose={onClose}
      widthRatio={0.62}
      heightRatio={0.7}
      className="docker-create-editor-subwindow"
      headerExtra={
        <Button size="xs" variant="primary" disabled={running} onClick={handleRun}>
          {running
            ? t("docker.dockPanel.createContainer.running")
            : t("docker.dockPanel.createContainer.run")}
        </Button>
      }
    >
      <div className="docker-create-editor-subwindow__body">
        {error ? <div className="docker-create-editor-subwindow__error">{error}</div> : null}
        <div className="docker-create-editor-subwindow__editor">
          <CodeEditor
            className="docker-create-editor-subwindow__code"
            value={jsonText}
            language="json"
            onChange={setJsonText}
            height="100%"
          />
        </div>
      </div>
    </SubWindow>
  );
}
