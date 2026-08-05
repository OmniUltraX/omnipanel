import { parseApifoxProject, isApifoxProject } from "./parseApifoxProject";
import type { ProtocolImportDocument } from "./protocolImportTypes";

export type ProtocolImportParseErrorCode =
  | "INVALID_JSON"
  | "UNSUPPORTED_FORMAT"
  | "EMPTY"
  | "UNKNOWN";

export class ProtocolImportParseError extends Error {
  readonly code: ProtocolImportParseErrorCode;

  constructor(code: ProtocolImportParseErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ProtocolImportParseError";
    this.code = code;
  }
}

/** 解析协议导入文件文本；目前支持 Apifox，后续可扩展 OpenAPI / Postman。 */
export function parseProtocolImportText(text: string): ProtocolImportDocument {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProtocolImportParseError("INVALID_JSON");
  }

  if (isApifoxProject(data)) {
    try {
      return parseApifoxProject(data);
    } catch (e) {
      if (e instanceof Error && e.message === "EMPTY") {
        throw new ProtocolImportParseError("EMPTY");
      }
      throw new ProtocolImportParseError("UNKNOWN", e instanceof Error ? e.message : String(e));
    }
  }

  throw new ProtocolImportParseError("UNSUPPORTED_FORMAT");
}
