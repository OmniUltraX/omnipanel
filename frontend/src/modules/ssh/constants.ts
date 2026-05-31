import type { DetailTab, ModuleTab } from "./types";

export const SSH_PATH = "/ssh";

export const MODULE_TABS: ModuleTab[] = ["hosts", "tunnels", "keys"];

export const DETAIL_TABS: DetailTab[] = [
  "overview",
  "terminal",
  "sftp",
  "tunnels",
  "monitoring",
];
