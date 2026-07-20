/** Docker daemon.json 基础表单模型：与源文件双向同步，保留未知键。 */

export type DockerCgroupDriver = "cgroupfs" | "systemd";

export interface DockerDaemonFormState {
  /** 镜像加速 URL，每行一个 */
  registryMirrors: string;
  /** 私有/不安全仓库，每行一个 */
  insecureRegistries: string;
  ipv6: boolean;
  logRotation: boolean;
  /** 如 10m */
  logMaxSize: string;
  /** 如 3 */
  logMaxFile: string;
  iptables: boolean;
  liveRestore: boolean;
  cgroupDriver: DockerCgroupDriver;
  /** hosts，每行一个；常见为 unix:///var/run/docker.sock */
  socketPath: string;
}

export const DEFAULT_DOCKER_DAEMON_FORM: DockerDaemonFormState = {
  registryMirrors: "",
  insecureRegistries: "",
  ipv6: false,
  logRotation: false,
  logMaxSize: "10m",
  logMaxFile: "3",
  iptables: true,
  liveRestore: false,
  cgroupDriver: "cgroupfs",
  socketPath: "",
};

const CGROUP_PREFIX = "native.cgroupdriver=";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function linesToList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function listToLines(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .join("\n");
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readLogOpts(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number") {
      out[key] = String(value);
    }
  }
  return out;
}

function parseCgroupDriver(execOpts: unknown): DockerCgroupDriver {
  if (!Array.isArray(execOpts)) return "cgroupfs";
  for (const item of execOpts) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed === `${CGROUP_PREFIX}systemd`) return "systemd";
    if (trimmed === `${CGROUP_PREFIX}cgroupfs`) return "cgroupfs";
  }
  return "cgroupfs";
}

function setCgroupDriver(execOpts: unknown, driver: DockerCgroupDriver): string[] {
  const next = Array.isArray(execOpts)
    ? execOpts.filter(
        (item): item is string =>
          typeof item === "string" && !item.trim().startsWith(CGROUP_PREFIX),
      )
    : [];
  next.push(`${CGROUP_PREFIX}${driver}`);
  return next;
}

/** 解析 daemon.json 文本到表单；失败抛错。 */
export function parseDaemonConfigToForm(content: string): DockerDaemonFormState {
  const trimmed = content.trim();
  const parsed: unknown = trimmed ? JSON.parse(trimmed) : {};
  if (!isPlainObject(parsed)) {
    throw new Error("daemon.json root must be an object");
  }

  const logOpts = readLogOpts(parsed["log-opts"]);
  const hasLogRotation = Boolean(logOpts["max-size"] || logOpts["max-file"]);

  return {
    registryMirrors: listToLines(parsed["registry-mirrors"]),
    insecureRegistries: listToLines(parsed["insecure-registries"]),
    ipv6: readBool(parsed.ipv6, false),
    logRotation: hasLogRotation,
    logMaxSize: logOpts["max-size"] || DEFAULT_DOCKER_DAEMON_FORM.logMaxSize,
    logMaxFile: logOpts["max-file"] || DEFAULT_DOCKER_DAEMON_FORM.logMaxFile,
    iptables: readBool(parsed.iptables, true),
    liveRestore: readBool(parsed["live-restore"], false),
    cgroupDriver: parseCgroupDriver(parsed["exec-opts"]),
    socketPath: listToLines(parsed.hosts),
  };
}

function setOrDeleteStringArray(
  doc: Record<string, unknown>,
  key: string,
  lines: string,
): void {
  const list = linesToList(lines);
  if (list.length === 0) {
    delete doc[key];
  } else {
    doc[key] = list;
  }
}

/** 将表单字段合并进 daemon.json，保留未知键。 */
export function mergeFormIntoDaemonConfig(
  content: string,
  form: DockerDaemonFormState,
): string {
  const trimmed = content.trim();
  const parsed: unknown = trimmed ? JSON.parse(trimmed) : {};
  if (!isPlainObject(parsed)) {
    throw new Error("daemon.json root must be an object");
  }

  const doc: Record<string, unknown> = { ...parsed };

  setOrDeleteStringArray(doc, "registry-mirrors", form.registryMirrors);
  setOrDeleteStringArray(doc, "insecure-registries", form.insecureRegistries);
  setOrDeleteStringArray(doc, "hosts", form.socketPath);

  if (form.ipv6) {
    doc.ipv6 = true;
  } else {
    delete doc.ipv6;
  }

  if (form.iptables) {
    // Docker 默认即为 true；显式写出便于表单回读一致
    doc.iptables = true;
  } else {
    doc.iptables = false;
  }

  if (form.liveRestore) {
    doc["live-restore"] = true;
  } else {
    delete doc["live-restore"];
  }

  doc["exec-opts"] = setCgroupDriver(doc["exec-opts"], form.cgroupDriver);

  const logOpts = readLogOpts(doc["log-opts"]);
  if (form.logRotation) {
    const maxSize = form.logMaxSize.trim() || DEFAULT_DOCKER_DAEMON_FORM.logMaxSize;
    const maxFile = form.logMaxFile.trim() || DEFAULT_DOCKER_DAEMON_FORM.logMaxFile;
    logOpts["max-size"] = maxSize;
    logOpts["max-file"] = maxFile;
    doc["log-opts"] = logOpts;
  } else {
    delete logOpts["max-size"];
    delete logOpts["max-file"];
    if (Object.keys(logOpts).length === 0) {
      delete doc["log-opts"];
    } else {
      doc["log-opts"] = logOpts;
    }
  }

  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function tryParseDaemonConfigToForm(
  content: string,
): { ok: true; form: DockerDaemonFormState } | { ok: false; error: string } {
  try {
    return { ok: true, form: parseDaemonConfigToForm(content) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
