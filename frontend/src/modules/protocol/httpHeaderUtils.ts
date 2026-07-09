import { HTTP_HEADER_KEYS } from "./httpHeaderPresets";

export type HttpHeaderKeyKind = "preset" | "custom";
export type HttpHeaderValueType = "string" | "current_unix_timestamp" | "base64";

export interface HttpHeaderPair {
  key: string;
  value: string;
  enabled: boolean;
  keyKind: HttpHeaderKeyKind;
  valueType: HttpHeaderValueType;
}

export const HTTP_HEADER_VALUE_TYPES: readonly HttpHeaderValueType[] = [
  "string",
  "current_unix_timestamp",
  "base64",
] as const;

export function createEmptyHeader(keyKind: HttpHeaderKeyKind): HttpHeaderPair {
  return {
    key: "",
    value: "",
    enabled: true,
    keyKind,
    valueType: "string",
  };
}

export function inferHeaderKeyKind(key: string): HttpHeaderKeyKind {
  const trimmed = key.trim();
  if (!trimmed) return "custom";
  return (HTTP_HEADER_KEYS as readonly string[]).includes(trimmed) ? "preset" : "custom";
}

function normalizeHeaderPair(raw: unknown): HttpHeaderPair {
  if (typeof raw !== "object" || raw === null) {
    return createEmptyHeader("custom");
  }
  const item = raw as Record<string, unknown>;
  const key = typeof item.key === "string" ? item.key : "";
  const value = typeof item.value === "string" ? item.value : "";
  const enabled = typeof item.enabled === "boolean" ? item.enabled : true;
  const keyKind =
    item.keyKind === "preset" || item.keyKind === "custom"
      ? item.keyKind
      : inferHeaderKeyKind(key);
  const valueType =
    item.valueType === "string" ||
    item.valueType === "current_unix_timestamp" ||
    item.valueType === "base64"
      ? item.valueType
      : "string";
  return { key, value, enabled, keyKind, valueType };
}

export function parseHttpHeaders(raw: string): HttpHeaderPair[] {
  if (!raw.trim()) {
    return [createEmptyHeader("preset")];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const pairs = parsed.map(normalizeHeaderPair);
      return pairs.length > 0 ? pairs : [createEmptyHeader("preset")];
    }
    if (typeof parsed === "object" && parsed !== null) {
      const pairs = Object.entries(parsed as Record<string, string>).map(([key, value]) => ({
        key,
        value: String(value),
        enabled: true,
        keyKind: inferHeaderKeyKind(key),
        valueType: "string" as const,
      }));
      return pairs.length > 0 ? pairs : [createEmptyHeader("preset")];
    }
  } catch {
    // fall through
  }
  return [createEmptyHeader("preset")];
}

export function serializeHttpHeaders(headers: HttpHeaderPair[]): string {
  return JSON.stringify(
    headers.map((h) => ({
      key: h.key,
      value: h.value,
      enabled: h.enabled,
      keyKind: h.keyKind,
      valueType: h.valueType,
    })),
  );
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function resolveHeaderValue(pair: HttpHeaderPair): string {
  switch (pair.valueType) {
    case "current_unix_timestamp":
      return String(Math.floor(Date.now() / 1000));
    case "base64":
      return encodeBase64(pair.value);
    default:
      return pair.value;
  }
}

export function buildHeaderMap(headers: HttpHeaderPair[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const header of headers) {
    if (header.enabled && header.key.trim()) {
      map[header.key.trim()] = resolveHeaderValue(header);
    }
  }
  return map;
}
