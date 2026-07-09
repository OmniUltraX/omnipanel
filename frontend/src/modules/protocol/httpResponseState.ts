import type { HttpEnvironment, HttpHistoryEntry } from "../../ipc/bindings";
import { splitUrlByEnvironment } from "./httpEnvironment";

export interface HttpResponseData {
  status: number;
  statusText: string;
  timeMs: number;
  sizeBytes: number;
  contentType: string;
  body: string;
  headers: Record<string, string>;
}

export interface HttpResponseSession {
  id: string;
  historyId: string | null;
  label: string;
  response: HttpResponseData;
  createdAt: number;
  curlCommand?: string | null;
}

export function makeHttpResponseSessionId(): string {
  return `resp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 未保存请求时使用此 key 存储响应 session */
export const HTTP_DRAFT_REQUEST_KEY = "__draft__";

export function resolveResponseRequestKey(selectedRequestId: string | null): string {
  return selectedRequestId ?? HTTP_DRAFT_REQUEST_KEY;
}

export function makeHttpResponseSessionLabel(index: number, status: number | null | undefined): string {
  if (status == null || status === 0) return `#${index}`;
  return `#${index} ${status}`;
}

export function resolveHistoryEntryEnvironmentId(
  entry: HttpHistoryEntry,
  environments: HttpEnvironment[],
): string | null {
  if (entry.environmentId) return entry.environmentId;
  return splitUrlByEnvironment(entry.url, environments).environmentId;
}

/** 历史记录默认名称：不含基地址的请求路径 */
export function historyEntryDefaultName(
  entry: HttpHistoryEntry,
  environments: HttpEnvironment[],
): string {
  const split = splitUrlByEnvironment(entry.url, environments);
  const path = split.path.trim();
  if (path) return path;
  return entry.url.trim() || "/";
}

/** 历史记录在侧栏/Tab 上的主显示文本 */
export function historyEntryDisplayLabel(
  entry: HttpHistoryEntry,
  environments: HttpEnvironment[] = [],
): string {
  const custom = entry.label?.trim();
  if (custom) return custom;
  return historyEntryDefaultName(entry, environments);
}

export function resolveHistoryEnvironmentName(
  entry: HttpHistoryEntry,
  environments: HttpEnvironment[],
): string | null {
  const envId = resolveHistoryEntryEnvironmentId(entry, environments);
  if (!envId) return null;
  return environments.find((item) => item.id === envId)?.name ?? null;
}

export function formatHistoryEntryDate(createdAt: number | null): string {
  if (createdAt == null || createdAt <= 0) return "—";
  return new Date(createdAt).toLocaleString();
}

/** 响应 Dock Tab 标签：优先用户命名，否则回退为 #N [status] */
export function historyEntrySessionLabel(
  entry: HttpHistoryEntry,
  index: number,
): string {
  const custom = entry.label?.trim();
  if (custom) return custom;
  return makeHttpResponseSessionLabel(index, entry.statusCode);
}

export function hasStoredResponse(entry: HttpHistoryEntry): boolean {
  return Boolean(
    entry.responseBody?.trim() ||
      entry.responseHeaders?.trim() ||
      entry.statusCode != null,
  );
}

export function historyEntryToResponse(entry: HttpHistoryEntry): HttpResponseData {
  let headers: Record<string, string> = {};
  try {
    headers = JSON.parse(entry.responseHeaders || "{}") as Record<string, string>;
  } catch {
    headers = {};
  }
  return {
    status: entry.statusCode ?? 0,
    statusText: entry.responseStatusText ?? "",
    timeMs: entry.responseTimeMs ?? 0,
    sizeBytes: entry.responseSize ?? 0,
    contentType: entry.responseContentType || "text/plain",
    body: entry.responseBody ?? "",
    headers,
  };
}

export function historyEntryToSession(entry: HttpHistoryEntry, index: number): HttpResponseSession {
  const requestCurl = (entry as HttpHistoryEntry & { requestCurl?: string | null }).requestCurl;
  return {
    id: entry.id,
    historyId: entry.id,
    label: historyEntrySessionLabel(entry, index),
    response: historyEntryToResponse(entry),
    createdAt: entry.createdAt ?? Date.now(),
    curlCommand: requestCurl?.trim() || null,
  };
}

export function responseDataToHistoryFields(response: HttpResponseData): {
  responseStatusText: string;
  responseContentType: string;
  responseHeaders: string;
  responseBody: string;
} {
  return {
    responseStatusText: response.statusText,
    responseContentType: response.contentType,
    responseHeaders: JSON.stringify(response.headers),
    responseBody: response.body,
  };
}

export function buildSessionsFromHistory(entries: HttpHistoryEntry[]): HttpResponseSession[] {
  return [...entries]
    .filter(hasStoredResponse)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .map((entry, index) => historyEntryToSession(entry, index + 1));
}
