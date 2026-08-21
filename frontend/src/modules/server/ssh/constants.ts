import type { DetailTab } from "./types";
import { MODULE_PATHS } from "../../../lib/paths";

/** SSH 主机选择记忆路径 */
export const SSH_PATH = MODULE_PATHS.ssh;

export const DETAIL_TABS: DetailTab[] = [
  "capabilities",
  "overview",
  "tunnels",
  "monitoring",
  "tmuxSessions",
];
