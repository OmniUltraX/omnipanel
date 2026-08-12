/** Rust `DockerConnectionSource` 经 serde kebab-case 序列化后的取值（如 OnePanel → `one-panel`）。 */
export type DockerConnectionSourceValue =
  | "local-engine"
  | "remote-engine"
  | "ssh-engine"
  | "one-panel"
  | "onepanel"
  | "panel-adapter"
  | "btpanel"
  | "baota"
  | (string & {});

export function normalizeDockerSource(source: DockerConnectionSourceValue): string {
  return String(source).trim().toLowerCase().replace(/_/g, "-");
}

/** 是否为本地 Docker Engine。 */
export function isLocalDockerSource(source: DockerConnectionSourceValue): boolean {
  return normalizeDockerSource(source) === "local-engine";
}

/** 是否为 SSH 宿主机 Docker 来源（远端 docker CLI）。 */
export function isSshDockerSource(source: DockerConnectionSourceValue): boolean {
  return normalizeDockerSource(source) === "ssh-engine";
}

/** 是否为 1Panel 面板来源（兼容 config 里的 `onepanel` 与枚举序列化的 `one-panel`）。 */
export function isOnePanelDockerSource(source: DockerConnectionSourceValue): boolean {
  const normalized = normalizeDockerSource(source);
  return normalized === "one-panel" || normalized === "onepanel";
}

/** 是否为宝塔（BT Panel）面板来源。 */
export function isBtPanelDockerSource(source: DockerConnectionSourceValue): boolean {
  const normalized = normalizeDockerSource(source);
  return (
    normalized === "panel-adapter" ||
    normalized === "btpanel" ||
    normalized === "baota"
  );
}

const SOURCE_LABELS: Record<string, string> = {
  "local-engine": "本地 Docker",
  "remote-engine": "远程 Engine（已停用）",
  "ssh-engine": "SSH 宿主机",
  "one-panel": "1Panel",
  onepanel: "1Panel",
  "panel-adapter": "宝塔",
  btpanel: "宝塔",
  baota: "宝塔",
};

export function dockerSourceLabel(source: DockerConnectionSourceValue): string {
  const normalized = normalizeDockerSource(source);
  return SOURCE_LABELS[normalized] ?? SOURCE_LABELS[source] ?? String(source);
}

/** 1Panel / 宝塔等面板来源：打开面板前必须绑定 SSH（无面板接口时回退）。 */
export function dockerSourceRequiresBoundSsh(source: DockerConnectionSourceValue): boolean {
  return isOnePanelDockerSource(source) || isBtPanelDockerSource(source);
}

/** 是否因缺少绑定 SSH 而禁止打开 Docker 工作区面板。 */
export function dockerConnectionMissingRequiredBoundSsh(connection: {
  source: DockerConnectionSourceValue;
  boundSshConnectionId?: string | null;
}): boolean {
  if (!dockerSourceRequiresBoundSsh(connection.source)) return false;
  return !connection.boundSshConnectionId?.trim();
}
