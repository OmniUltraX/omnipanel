import { formatHexDump } from "../../../lib/hexDump";

export interface RedisEscapedBinary {
  bytes: Uint8Array;
  truncated: boolean;
}

/** 解析后端 `escape_bytes_preview` 输出的 `\xHH` 转义串。 */
export function parseRedisEscapedBinary(text: string): RedisEscapedBinary | null {
  if (!text.startsWith("\\x")) {
    return null;
  }
  const truncated = text.endsWith("…");
  const body = truncated ? text.slice(0, -1) : text;
  const matches = body.match(/\\x[0-9a-fA-F]{2}/g);
  if (!matches || matches.length === 0) {
    return null;
  }
  const bytes = new Uint8Array(matches.length);
  for (let i = 0; i < matches.length; i += 1) {
    bytes[i] = Number.parseInt(matches[i]!.slice(2), 16);
  }
  return { bytes, truncated };
}

export function isRedisEscapedBinary(text: string): boolean {
  return parseRedisEscapedBinary(text) != null;
}

const FORMAT_DETECTORS: Array<{ id: string; match: (bytes: Uint8Array) => boolean }> = [
  {
    id: "javaSerialization",
    match: (bytes) =>
      bytes.length >= 4 &&
      bytes[0] === 0xac &&
      bytes[1] === 0xed &&
      bytes[2] === 0x00 &&
      bytes[3] === 0x05,
  },
  {
    id: "gzip",
    match: (bytes) => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b,
  },
  {
    id: "zlib",
    match: (bytes) => bytes.length >= 2 && bytes[0] === 0x78 && (bytes[1]! & 0xf0) === 0x70,
  },
];

export function detectRedisBinaryFormat(bytes: Uint8Array): string {
  for (const detector of FORMAT_DETECTORS) {
    if (detector.match(bytes)) {
      return detector.id;
    }
  }
  return "binary";
}

export function buildRedisBinaryHexDump(bytes: Uint8Array): string {
  return formatHexDump(bytes);
}
