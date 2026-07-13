/** Rust `DockerConnectionSource` 经 serde kebab-case 序列化后的取值（如 OnePanel → `one-panel`）。 */
export type DockerConnectionSourceValue =
  | "local-engine"
  | "remote-engine"
  | "ssh-engine"
  | "one-panel"
  | "onepanel"
  | "panel-adapter"
  | (string & {});

export function normalizeDockerSource(source: DockerConnectionSourceValue): string {
  return String(source).trim().toLowerCase().replace(/_/g, "-");
}

/** 是否为 SSH 宿主机 Docker 来源（远端 docker CLI）。 */
export function isSshDockerSource(source: DockerConnectionSourceValue): boolean {
  return normalizeDockerSource(source) === "ssh-engine";
}

/** 是否为 1Panel / 面板适配来源（兼容 config 里的 `onepanel` 与枚举序列化的 `one-panel`）。 */
export function isOnePanelDockerSource(source: DockerConnectionSourceValue): boolean {
  const normalized = normalizeDockerSource(source);
  return (
    normalized === "one-panel" ||
    normalized === "onepanel" ||
    normalized === "panel-adapter"
  );
}

const SOURCE_LABELS: Record<string, string> = {
  "local-engine": "本地 Docker",
  "remote-engine": "远程 Engine（已停用）",
  "ssh-engine": "SSH 宿主机",
  "one-panel": "1Panel",
  onepanel: "1Panel",
  "panel-adapter": "面板",
};

export function dockerSourceLabel(source: DockerConnectionSourceValue): string {
  const normalized = normalizeDockerSource(source);
  return SOURCE_LABELS[normalized] ?? SOURCE_LABELS[source] ?? String(source);
}
