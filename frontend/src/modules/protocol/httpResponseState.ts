import type { HttpHistoryEntry } from "../../ipc/bindings";

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
  return {
    id: entry.id,
    historyId: entry.id,
    label: makeHttpResponseSessionLabel(index, entry.statusCode),
    response: historyEntryToResponse(entry),
    createdAt: entry.createdAt ?? Date.now(),
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
