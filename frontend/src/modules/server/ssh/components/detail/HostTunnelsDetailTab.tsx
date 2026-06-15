import { TunnelPanel } from "../../../../../components/tunnel";
import type { WorkspaceResource } from "../../../../../lib/resourceRegistry";

type Props = {
  activeResource: WorkspaceResource | null;
};

export function HostTunnelsDetailTab({ activeResource }: Props) {
  return <TunnelPanel activeResource={activeResource} />;
}
