import { SubWindow } from "../../../components/ui/window";
import type { DockerContainerSubWindowKind } from "../DockerDockPanel";
import { DockerContainerDirectoryView } from "./DockerContainerDirectoryView";
import { DockerContainerLogsView } from "./DockerContainerLogsView";
import { DockerContainerParamsView } from "./DockerContainerParamsView";

export interface DockerContainerSubWindowProps {
  open: boolean;
  kind: DockerContainerSubWindowKind;
  title: string;
  containerName: string;
  connectionId: string;
  containerId: string;
  onClose: () => void;
}

export function DockerContainerSubWindow({
  open,
  kind,
  title,
  containerName,
  connectionId,
  containerId,
  onClose,
}: DockerContainerSubWindowProps) {
  const content =
    kind === "logs" ? (
      <DockerContainerLogsView connectionId={connectionId} containerId={containerId} visible={open} />
    ) : kind === "directory" ? (
      <DockerContainerDirectoryView connectionId={connectionId} containerId={containerId} />
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
