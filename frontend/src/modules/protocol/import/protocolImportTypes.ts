/** 协议实验室导入：格式无关中间模型（后续可接 OpenAPI / Postman 等）。 */

export type ProtocolImportFormat = "apifox";

export interface ProtocolImportKv {
  key: string;
  value: string;
  enabled: boolean;
}

export interface ProtocolImportRequest {
  name: string;
  method: string;
  /** 路径或完整 URL；路径参数已规范为 `:name` */
  url: string;
  headers: ProtocolImportKv[];
  queryParams: ProtocolImportKv[];
  pathParams: ProtocolImportKv[];
  body: string;
  authType: string;
  authValue: string;
}

export interface ProtocolImportFolder {
  name: string;
  children: ProtocolImportNode[];
}

export type ProtocolImportNode =
  | { kind: "folder"; folder: ProtocolImportFolder }
  | { kind: "request"; request: ProtocolImportRequest };

export interface ProtocolImportDocument {
  format: ProtocolImportFormat;
  name: string;
  roots: ProtocolImportNode[];
}

export interface ProtocolImportStats {
  folderCount: number;
  requestCount: number;
}

export function countImportNodes(nodes: ProtocolImportNode[]): ProtocolImportStats {
  let folderCount = 0;
  let requestCount = 0;
  const walk = (list: ProtocolImportNode[]) => {
    for (const node of list) {
      if (node.kind === "request") {
        requestCount += 1;
      } else {
        folderCount += 1;
        walk(node.folder.children);
      }
    }
  };
  walk(nodes);
  return { folderCount, requestCount };
}
