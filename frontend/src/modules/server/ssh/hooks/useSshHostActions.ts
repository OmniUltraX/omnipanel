import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import { useI18n } from "../../../../i18n";
import {
  jumpSshDocker,
  jumpSshPanel,
  jumpSshSftp,
  jumpSshTerminal,
} from "../sshHostQuickJumps";
import type { SshHostContext } from "./useSshHostContext";

export function useSshHostActions(
  resource: WorkspaceResource | null,
  context: Pick<SshHostContext, "dockerConnection" | "panelConnection">,
  options?: {
    onOpenTunnels?: () => void;
  },
) {
  const navigate = useNavigate();
  const { t } = useI18n();

  const openTerminal = useCallback(() => {
    if (!resource) return;
    jumpSshTerminal(resource.id, resource.name);
  }, [resource]);

  const openSftp = useCallback(() => {
    if (!resource) return;
    jumpSshSftp(resource.id, { hostName: resource.name, navigate });
  }, [navigate, resource]);

  const openDocker = useCallback(() => {
    if (!resource) return;
    void jumpSshDocker(
      resource.id,
      context.dockerConnection ? undefined : t("ssh.quickActions.dockerMissing"),
    );
  }, [context.dockerConnection, resource, t]);

  const openPanel = useCallback(() => {
    if (!resource) return;
    jumpSshPanel(
      resource.id,
      context.panelConnection ? undefined : t("ssh.quickActions.panelMissing"),
    );
  }, [context.panelConnection, resource, t]);

  const openTunnels = useCallback(() => {
    options?.onOpenTunnels?.();
  }, [options]);

  return {
    openTerminal,
    openSftp,
    openDocker,
    openPanel,
    openTunnels,
    hasDocker: Boolean(context.dockerConnection),
    hasPanel: Boolean(context.panelConnection),
  };
}
