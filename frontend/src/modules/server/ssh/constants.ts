import type { DetailTab } from "./types";
import { MODULE_PATHS } from "../../../lib/paths";

export const SSH_PATH = MODULE_PATHS.ssh;

export const DETAIL_TABS: DetailTab[] = [
  "overview",
  "terminal",
  "sftp",
  "tunnels",
  "monitoring",
];
