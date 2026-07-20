import { useCallback, useEffect, useState } from "react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "../../../components/ui/Button";
import { CodeEditor } from "../../../components/ui/content/CodeEditor";
import { SubWindow } from "../../../components/ui/window";
import { useI18n } from "../../../i18n";
import { formatIpcError } from "../../../ipc/result";
import { showToast } from "../../../stores/toastStore";
import { invalidateComposeProjectMeta, runComposeAction, writeComposeProjectFiles } from "../dockerComposeApi";
import { splitComposeFilePath } from "../dockerComposeFilePath";

export interface DockerCreateComposeSubWindowProps {
  open: boolean;
  connectionId: string;
  onClose: () => void;
  onCreated: () => void;
}

const DEFAULT_COMPOSE_YAML = `services:
  app:
    image: nginx:latest
    ports:
      - "8080:80"
`;

export function DockerCreateComposeSubWindow({
  open,
  connectionId,
  onClose,
  onCreated,
}: DockerCreateComposeSubWindowProps) {
  const { t } = useI18n();
  const [yamlText, setYamlText] = useState(DEFAULT_COMPOSE_YAML);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setYamlText(DEFAULT_COMPOSE_YAML);
    setError(null);
    setRunning(false);
  }, [open]);

  const handleRun = useCallback(() => {
    void (async () => {
      setError(null);
      if (!yamlText.trim()) {
        setError(t("docker.dockPanel.createCompose.empty"));
        return;
      }

      const destPath = await saveFileDialog({
        title: t("docker.dockPanel.createCompose.saveTitle"),
        defaultPath: "docker-compose.yml",
        filters: [
          { name: "Compose", extensions: ["yml", "yaml"] },
          { name: "All", extensions: ["*"] },
        ],
      });
      if (!destPath || typeof destPath !== "string") return;

      setRunning(true);
      try {
        const { workingDir, configFile, project } = splitComposeFilePath(destPath);
        await writeComposeProjectFiles(connectionId, {
          project,
          workingDir,
          configFile,
          composePath: destPath,
          composeContent: yamlText,
          envPath: null,
          envContent: null,
        });
        const result = await runComposeAction(connectionId, "up", {
          project,
          workingDir,
          configFile,
          services: [],
          detached: true,
        });
        if (result.exitCode !== 0) {
          const detail = [result.stderrExcerpt, result.stdoutExcerpt].filter(Boolean).join("\n");
          throw new Error(detail || t("docker.composePanel.actionFailed"));
        }
        invalidateComposeProjectMeta(connectionId);
        showToast(t("docker.dockPanel.createCompose.success", { project }));
        onCreated();
        onClose();
      } catch (e) {
        setError(formatIpcError(e) || String(e));
      } finally {
        setRunning(false);
      }
    })();
  }, [connectionId, onClose, onCreated, t, yamlText]);

  return (
    <SubWindow
      open={open}
      title={t("docker.dockPanel.createCompose.title")}
      onClose={onClose}
      widthRatio={0.62}
      heightRatio={0.7}
      className="docker-create-editor-subwindow"
      headerExtra={
        <Button size="xs" variant="primary" disabled={running} onClick={handleRun}>
          {running
            ? t("docker.dockPanel.createCompose.running")
            : t("docker.dockPanel.createCompose.run")}
        </Button>
      }
    >
      <div className="docker-create-editor-subwindow__body">
        {error ? <div className="docker-create-editor-subwindow__error">{error}</div> : null}
        <div className="docker-create-editor-subwindow__editor">
          <CodeEditor
            className="docker-create-editor-subwindow__code"
            value={yamlText}
            language="yaml"
            onChange={setYamlText}
            height="100%"
          />
        </div>
      </div>
    </SubWindow>
  );
}
