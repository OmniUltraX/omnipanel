import { SubWindow } from "../../../components/ui/window";
import type { DockerConnectionSource } from "../../../ipc/bindings";
import type { DockerContainerSubWindowKind } from "../DockerDockPanel";
import { DockerContainerSftpPanel } from "../DockerContainerSftpPanel";
import { DockerContainerLogsView } from "./DockerContainerLogsView";
import { DockerContainerParamsView } from "./DockerContainerParamsView";

export interface DockerContainerSubWindowProps {
  open: boolean;
  kind: DockerContainerSubWindowKind;
  title: string;
  containerName: string;
  connectionId: string;
  containerId: string;
  connectionSource: DockerConnectionSource;
  onClose: () => void;
}

export function DockerContainerSubWindow({
  open,
  kind,
  title,
  containerName,
  connectionId,
  containerId,
  connectionSource,
  onClose,
}: DockerContainerSubWindowProps) {
  const content =
    kind === "logs" ? (
      <DockerContainerLogsView connectionId={connectionId} containerId={containerId} visible={open} />
    ) : kind === "directory" ? (
      <DockerContainerSftpPanel
        connectionId={connectionId}
        containerId={containerId}
        source={connectionSource}
        className="docker-container-subwindow docker-container-subwindow--directory"
      />
    ) : (
      <DockerContainerParamsView connectionId={connectionId} containerId={containerId} />
    );

  return (
    <SubWindow
      open={open}
      title={`${title} · ${containerName}`}
      onClose={onClose}
      widthRatio={0.72}
      heightRatio={0.68}
      className="docker-container-subwindow-shell"
    >
      {content}
    </SubWindow>
  );
}
