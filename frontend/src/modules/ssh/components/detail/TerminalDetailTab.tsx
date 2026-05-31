import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import { SshTerminalWorkspace } from "../../terminal/SshTerminalWorkspace";

type Props = {
  activeResource: WorkspaceResource | null;
  detailTabActive: boolean;
};

export function TerminalDetailTab({
  activeResource,
  detailTabActive,
}: Props) {
  return (
    <SshTerminalWorkspace
      resource={activeResource}
      active={detailTabActive}
    />
  );
}
