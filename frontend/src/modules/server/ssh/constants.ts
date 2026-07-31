import type { DetailTab } from "./types";
import { MODULE_PATHS } from "../../../lib/paths";

/** SSH 主机选择记忆挂在终端模块路径下（SSH 已并入终端） */
export const SSH_PATH = MODULE_PATHS.terminal;

export const DETAIL_TABS: DetailTab[] = [
  "overview",
  "tunnels",
  "monitoring",
  "tmuxSessions",
];
