import type { HttpEnvironment } from "../../ipc/bindings";

export const HTTP_ACTIVE_ENV_STORAGE_KEY = "omnipanel-protocol-http-active-environment-id";

const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function isAbsoluteHttpUrl(value: string): boolean {
  return ABSOLUTE_URL_RE.test(value.trim());
}

export function buildHttpRequestUrl(baseUrl: string, path: string): string {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return normalizeBaseUrl(baseUrl);
  }
  if (isAbsoluteHttpUrl(trimmedPath)) {
    return trimmedPath;
  }
  const base = normalizeBaseUrl(baseUrl);
  const suffix = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  return `${base}${suffix}`;
}

export function resolveHttpRequestUrl(
  path: string,
  environmentId: string | null,
  environments: HttpEnvironment[],
): string | null {
  const trimmedPath = path.trim();
  if (isAbsoluteHttpUrl(trimmedPath)) {
    return trimmedPath;
  }
  const env =
    (environmentId ? environments.find((item) => item.id === environmentId) : null) ??
    environments[0] ??
    null;
  if (!env?.baseUrl.trim()) {
    return trimmedPath ? null : null;
  }
  return buildHttpRequestUrl(env.baseUrl, trimmedPath);
}

export function splitUrlByEnvironment(
  fullUrl: string,
  environments: HttpEnvironment[],
): { environmentId: string | null; path: string } {
  const trimmed = fullUrl.trim();
  if (!trimmed) {
    return { environmentId: null, path: "" };
  }
  if (!isAbsoluteHttpUrl(trimmed)) {
    return { environmentId: null, path: trimmed };
  }

  const sorted = [...environments].sort(
    (a, b) => normalizeBaseUrl(b.baseUrl).length - normalizeBaseUrl(a.baseUrl).length,
  );
  for (const env of sorted) {
    const base = normalizeBaseUrl(env.baseUrl);
    if (!base) continue;
    if (trimmed === base || trimmed.startsWith(`${base}/`)) {
      const pathPart = trimmed.slice(base.length);
      return {
        environmentId: env.id,
        path: pathPart.startsWith("/") ? pathPart : `/${pathPart}`,
      };
    }
  }

  return { environmentId: null, path: trimmed };
}

export function readStoredActiveEnvironmentId(): string | null {
  try {
    return localStorage.getItem(HTTP_ACTIVE_ENV_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredActiveEnvironmentId(id: string | null): void {
  try {
    if (!id) {
      localStorage.removeItem(HTTP_ACTIVE_ENV_STORAGE_KEY);
      return;
    }
    localStorage.setItem(HTTP_ACTIVE_ENV_STORAGE_KEY, id);
  } catch {
    // ignore quota / private mode
  }
}
