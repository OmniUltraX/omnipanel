/**
 * 将 registry-mirrors 地址映射为镜像站网页根域名。
 * 例：https://docker.1ms.run → https://1ms.run
 */
export function mirrorToHomepageOrigin(mirror: string): string {
  const trimmed = mirror.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return trimmed;
  }
  const host = url.hostname.toLowerCase();
  if (host === "1ms.run" || host.endsWith(".1ms.run")) {
    return "https://1ms.run";
  }
  return `${url.protocol}//${url.host}`;
}

/** 官方短名补 library/；已有命名空间则原样。 */
export function imageRepoPath(name: string, isOfficial: boolean): string {
  const n = name.trim().replace(/^\/+/, "");
  if (!n) return "";
  if (n.includes("/")) return n;
  if (isOfficial) return `library/${n}`;
  return n;
}

/**
 * 拼镜像主页 URL。
 * - 有本次搜索命中的 mirror：`{homepageOrigin}/r/{repo}`
 * - 无 mirror（Hub/CLI 回退）：官方短名走 Hub `/_/`，其余走 `/r/`
 */
export function buildDockerImageHomepageUrl(
  sourceMirror: string | null | undefined,
  name: string,
  isOfficial: boolean,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const path = imageRepoPath(trimmed, isOfficial);
  if (!path) return null;

  if (sourceMirror?.trim()) {
    const origin = mirrorToHomepageOrigin(sourceMirror);
    if (!origin) return null;
    return `${origin}/r/${path}`;
  }

  if (!trimmed.includes("/") && isOfficial) {
    return `https://hub.docker.com/_/${trimmed}`;
  }
  return `https://hub.docker.com/r/${path}`;
}
