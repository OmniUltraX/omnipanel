/** 空态文案：仅在真正没有连接时说「暂无 SSH 连接」。 */
export function sshEmptyPromptKey(
  hasConnections: boolean,
): "ssh.empty.chooseHost" | "ssh.empty.selectHost" {
  return hasConnections ? "ssh.empty.chooseHost" : "ssh.empty.selectHost";
}
