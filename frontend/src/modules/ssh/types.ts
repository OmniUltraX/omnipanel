export type ModuleTab = "hosts" | "tunnels" | "keys";

export type DetailTab =
  | "overview"
  | "terminal"
  | "sftp"
  | "tunnels"
  | "monitoring";

export type LaunchPreset = {
  id: string;
  title: string;
  desc: string;
  purpose: string;
  commands: string[];
  tone: "accent" | "success" | "warn";
};

export type HostActivity = {
  time: string;
  command: string;
  status: "ok" | "warn";
};

export type HostFile = {
  name: string;
  type: string;
  size: string;
  modified: string;
};

export type HostTunnel = {
  local: string;
  remote: string;
  status: string;
};

export type RelatedModule = {
  label: string;
  desc: string;
  path: string;
  resourceId?: string;
};

export type HostProfile = {
  os: string;
  uptime: string;
  connected: string;
  username: string;
  authMethod: string;
  keyFile: string;
  keyScope: string;
  cpu: string;
  memory: string;
  disk: string;
  network: string;
  tags: string[];
  recentActivity: HostActivity[];
  files: HostFile[];
  tunnels: HostTunnel[];
  presets: LaunchPreset[];
  relatedModules: RelatedModule[];
  notes: string[];
};

export type SshKeyInfo = {
  name: string;
  meta: string;
  usage: string;
};

export type HostSignal = {
  title: string;
  desc: string;
};
