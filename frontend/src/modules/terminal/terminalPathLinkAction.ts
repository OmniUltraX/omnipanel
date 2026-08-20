import { t } from "../../i18n";
import { showToast } from "../../stores/toastStore";
import { LOCAL_CONNECTION_ID } from "../files/utils";
import { terminalCdCommand } from "./terminalPathCrumbs";
import { maybeAppendAutoLsToPtyCommand } from "./terminalAutoLs";
import {
  decidePathLinkAction,
  type PathLinkAction,
  type PathLinkKind,
} from "./terminalFileLinks";
import {
  resolvePreviewConnectionId,
  tryOpenTerminalFilePreview,
} from "./terminalFilePreviewStore";

export type { PathLinkAction };

export function activateClassifiedPathLink(params: {
  kind: PathLinkKind;
  absolutePath: string;
  name: string;
  sessionType: "local" | "remote";
  resourceId: string | null;
  canSendCd: boolean;
  sendCommand?: (cmd: string) => void;
  sessionId?: string;
}): PathLinkAction {
  const action = decidePathLinkAction(params.kind, params.canSendCd);
  if (action === "cd") {
    const cd = terminalCdCommand(params.absolutePath);
    params.sendCommand?.(
      params.sessionId ? maybeAppendAutoLsToPtyCommand(cd, params.sessionId) : cd,
    );
    return action;
  }
  if (action === "cd-blocked") {
    showToast(t("terminal.fileLink.cdBusy"));
    return action;
  }
  const isLocal = params.sessionType === "local";
  tryOpenTerminalFilePreview({
    connectionId: isLocal
      ? LOCAL_CONNECTION_ID
      : resolvePreviewConnectionId(params.sessionType, params.resourceId),
    absolutePath: params.absolutePath,
    name: params.name,
    resourceId: isLocal ? null : params.resourceId,
    sessionType: params.sessionType,
  });
  return action;
}
