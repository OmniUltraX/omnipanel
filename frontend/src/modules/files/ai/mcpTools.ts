import { invoke } from "@tauri-apps/api/core";

import type { BuiltinToolRegistration } from "../../../lib/ai/context";
import { optionalString, requireString } from "../../../lib/ai/mcpToolArgs";
import type {
  FileEntry,
  FileListDirResult,
  FileManagerConnectionInfo,
} from "../../../ipc/bindings";

/**
 * Files 模块向 AI 注册的 MCP 工具（UiDelegated）。
 *
 * 与 `BUILTIN_TOOL_SPECS` 中 `omni_files_*` 的 schema 一一对应。
 * 所有工具底层复用既有的 Tauri 命令：
 * - `file_list_connections`（Native，由后端直接执行）
 * - `file_list_dir` / `file_read_file` / `file_upload_file` / `file_s3_search`
 *
 * 设计要点：
 * - `connection_id` 本机固定为 '__local__'；其他来源用
 *   `omni_files_list_connections`（Native 工具）查询。
 * - read 工具默认 max_bytes=512KB，硬上限 8MB（与 src-tauri 一致）。
 * - write 工具支持 append=false（默认覆盖）/ true（追加），父目录自动创建。
 * - search 工具统一走 `file_list_dir` 带 search 参数（覆盖 local/SFTP/FTP）；
 *   S3 协议由 src-tauri 的 `file_list_dir` 内部分支处理（按文件名子串匹配）。
 *   仅返回当前目录一层匹配项，不递归。
 * - 危险动作（覆盖系统文件）由 UiDelegated 通道统一审批。
 */

/** Files 工具调用 file_list_dir 的参数（与 Tauri 命令对齐） */
interface FileListDirInvokeArgs {
  connectionId: string;
  path: string;
  search: string | null;
  continuationToken: string | null;
}

/** Files 工具调用 file_read_file 的参数 */
interface FileReadFileInvokeArgs {
  connectionId: string;
  path: string;
  maxBytes: number;
}

/** Files 工具调用 file_upload_file 的参数 */
interface FileUploadFileInvokeArgs {
  connectionId: string;
  path: string;
  data: number[];
}

/** 默认读取上限：512KB（与 src-tauri `local_read` 默认一致） */
const DEFAULT_READ_MAX_BYTES = 512 * 1024;
/** 硬上限：8MB（防止 AI 读超大文件爆 token） */
const MAX_READ_BYTES = 8 * 1024 * 1024;

/** FileEntry 精简视图（去掉 path/permissions 等冗余，保留 AI 关心的字段） */
interface FileEntryAiSummary {
  name: string;
  kind: string;
  size: number | null;
  modified: number | null;
  permissions: string | null;
}

function toAiSummary(e: FileEntry): FileEntryAiSummary {
  return {
    name: e.name,
    kind: e.kind,
    size: e.size,
    modified: e.modified,
    permissions: e.permissions,
  };
}

/** 把字节数组解码为 UTF-8 字符串（无效字节替换为 U+FFFD） */
function decodeBytesAsUtf8(bytes: number[]): string {
  const u8 = new Uint8Array(bytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(u8);
}

/** 把 UTF-8 字符串编码为字节数组（与 src-tauri 期望的 Vec<u8> 对齐） */
function encodeStringToBytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

async function filesList(args: Record<string, unknown>): Promise<string> {
  const connection_id = requireString(args, "connection_id");
  const path = requireString(args, "path");
  const search = optionalString(args, "search");
  const result = await invoke<FileListDirResult>("file_list_dir", {
    connectionId: connection_id,
    path,
    search: search ?? null,
    continuationToken: null,
  } satisfies FileListDirInvokeArgs);
  const simplified = result.entries.map(toAiSummary);
  return JSON.stringify(
    {
      connectionId: connection_id,
      path,
      search: search ?? null,
      count: simplified.length,
      truncated: result.truncated,
      entries: simplified,
    },
    null,
    2,
  );
}

async function filesRead(args: Record<string, unknown>): Promise<string> {
  const connection_id = requireString(args, "connection_id");
  const path = requireString(args, "path");
  const rawMax = args.max_bytes;
  const maxBytes =
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0
      ? Math.min(Math.floor(rawMax), MAX_READ_BYTES)
      : DEFAULT_READ_MAX_BYTES;
  const bytes = await invoke<number[]>("file_read_file", {
    connectionId: connection_id,
    path,
    maxBytes,
  } satisfies FileReadFileInvokeArgs);
  const content = decodeBytesAsUtf8(bytes);
  return JSON.stringify(
    {
      connectionId: connection_id,
      path,
      maxBytes,
      actualBytes: bytes.length,
      truncated: bytes.length >= maxBytes,
      content,
    },
    null,
    2,
  );
}

async function filesWrite(args: Record<string, unknown>): Promise<string> {
  const connection_id = requireString(args, "connection_id");
  const path = requireString(args, "path");
  const content = requireString(args, "content");
  const append = args.append === true;
  // src-tauri 的 file_upload_file 是覆盖写；append 模式下先读旧内容再拼接
  let data: number[];
  if (append) {
    let existing = "";
    try {
      const existingBytes = await invoke<number[]>("file_read_file", {
        connectionId: connection_id,
        path,
        maxBytes: MAX_READ_BYTES,
      } satisfies FileReadFileInvokeArgs);
      existing = decodeBytesAsUtf8(existingBytes);
    } catch {
      // 文件不存在时忽略错误，等价于新建
    }
    data = encodeStringToBytes(existing + content);
  } else {
    data = encodeStringToBytes(content);
  }
  await invoke<void>("file_upload_file", {
    connectionId: connection_id,
    path,
    data,
  } satisfies FileUploadFileInvokeArgs);
  return JSON.stringify(
    {
      connectionId: connection_id,
      path,
      append,
      bytesWritten: data.length,
      applied: true,
    },
    null,
    2,
  );
}

async function filesSearch(args: Record<string, unknown>): Promise<string> {
  const connection_id = requireString(args, "connection_id");
  const query = requireString(args, "query");
  const path = optionalString(args, "path") ?? "";
  // 统一走 file_list_dir 带 search 参数；S3 协议由 src-tauri 内部处理
  const result = await invoke<FileListDirResult>("file_list_dir", {
    connectionId: connection_id,
    path,
    search: query,
    continuationToken: null,
  } satisfies FileListDirInvokeArgs);
  const simplified = result.entries.map(toAiSummary);
  return JSON.stringify(
    {
      connectionId: connection_id,
      query,
      path: path || null,
      count: simplified.length,
      truncated: result.truncated,
      results: simplified,
    },
    null,
    2,
  );
}

const connectionIdSchema = {
  type: "string",
  description:
    "文件连接 id；本机用 '__local__'，可先用 omni_files_list_connections 查询",
};

/** Files 模块 MCP 工具名（omni_{module}_{function_name}） */
export const FILES_MODULE_TOOLS: BuiltinToolRegistration[] = [
  {
    name: "omni_files_list",
    description:
      "列出指定目录下的文件与子目录（含大小/修改时间/权限）。可选 search 按文件名子串过滤。\
本机空 path 表示用户主目录；Windows '\\\\' 表示此电脑根（盘符列表）。",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: connectionIdSchema,
        path: {
          type: "string",
          description: "目录绝对路径；本机空串或 '/' 表示用户主目录，'\\\\' 表示 Windows 此电脑根",
        },
        search: {
          type: "string",
          description: "可选，按文件名子串过滤（忽略大小写）",
        },
      },
      required: ["connection_id", "path"],
    },
    handler: filesList,
  },
  {
    name: "omni_files_read",
    description:
      "读取文件文本内容（UTF-8）。默认上限 512KB，最大 8MB。\
二进制文件会被解码为 UTF-8 替换字符（不影响 AI 阅读文本配置/日志）。",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: connectionIdSchema,
        path: {
          type: "string",
          description: "文件绝对路径",
        },
        max_bytes: {
          type: "integer",
          description: "最多读取字节数，默认 524288（512KB），上限 8388608（8MB）",
        },
      },
      required: ["connection_id", "path"],
    },
    handler: filesRead,
  },
  {
    name: "omni_files_write",
    description:
      "将文本内容写入文件（默认覆盖；append=true 追加）。父目录不存在会自动创建。\
危险动作（覆盖关键系统文件）需用户确认。",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: connectionIdSchema,
        path: {
          type: "string",
          description: "文件绝对路径；父目录不存在会自动创建",
        },
        content: {
          type: "string",
          description: "要写入的文本内容（UTF-8），将完整覆盖原文件",
        },
        append: {
          type: "boolean",
          description: "可选，true=追加到文件末尾，false/默认=覆盖",
        },
      },
      required: ["connection_id", "path", "content"],
    },
    handler: filesWrite,
  },
  {
    name: "omni_files_search",
    description:
      "按文件名子串搜索（忽略大小写）。S3 协议下含 '/' 时按 key 前缀查询。\
仅返回当前目录一层匹配项，不递归（递归搜索请配合 SSH find / grep）。",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: connectionIdSchema,
        query: {
          type: "string",
          description: "搜索关键词（文件名子串，忽略大小写）。S3 协议下含 '/' 时按 key 前缀查询",
        },
        path: {
          type: "string",
          description: "可选，搜索起始目录；默认为连接根路径",
        },
      },
      required: ["connection_id", "query"],
    },
    handler: filesSearch,
  },
];

/** 仅供 typecheck 保证导入被使用（不参与运行时） */
export type { FileManagerConnectionInfo };
