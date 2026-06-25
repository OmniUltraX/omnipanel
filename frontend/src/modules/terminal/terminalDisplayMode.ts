/** Command Bar（external）模式下 Block Feed 为主界面，xterm 仅 live tail */
import { useTerminalUiStore } from "./terminalUiStore";

export function isWarpDisplay(sessionId: string): boolean {
  return useTerminalUiStore.getState().getInputMode(sessionId) === "external";
}
