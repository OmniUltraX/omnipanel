import type { BuiltinToolRegistration } from "../../../lib/ai/context";
import { requireString } from "../../../lib/ai/mcpToolArgs";
import { runWithToolGate } from "../../../lib/ai/toolGate";
import { commands, type StudioProject } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import { notifyPluginStudioFileWritten } from "../studioFileEvents";

function requireContent(args: Record<string, unknown>): string {
  const value = args.content;
  if (typeof value !== "string") {
    throw new Error("缺少必填参数：content");
  }
  return value;
}

function summarizeProject(item: StudioProject) {
  return {
    name: item.name,
    location: item.location ?? "user",
    kind: item.kind ?? null,
    version: item.version ?? null,
    displayName: item.displayName ?? null,
    files: item.files,
  };
}

async function studioListProjects(): Promise<string> {
  const list = await unwrapCommand(commands.pluginStudioListProjects(), { quiet: true });
  return JSON.stringify(
    { count: list.length, projects: list.map(summarizeProject) },
    null,
    2,
  );
}

async function studioReadFile(args: Record<string, unknown>): Promise<string> {
  const project = requireString(args, "project");
  const path = requireString(args, "path");
  const content = await unwrapCommand(commands.pluginStudioReadFile(project, path));
  return JSON.stringify({ project, path, bytes: content.length, content }, null, 2);
}

async function studioWriteFile(args: Record<string, unknown>): Promise<string> {
  const project = requireString(args, "project");
  const path = requireString(args, "path");
  const content = requireContent(args);

  const doWrite = async (): Promise<string> => {
    await unwrapCommand(commands.pluginStudioWriteFile(project, path, content));
    notifyPluginStudioFileWritten(project, path);
    return JSON.stringify(
      { project, path, bytesWritten: content.length, applied: true },
      null,
      2,
    );
  };

  return runWithToolGate(
    {
      toolName: "omni_studio_write_file",
      args,
      resourceId: project,
      channel: "ui-delegated",
    },
    doWrite,
  );
}

async function studioValidate(args: Record<string, unknown>): Promise<string> {
  const project = requireString(args, "project");
  const result = await unwrapCommand(commands.pluginStudioRun(project, "validate"));
  return JSON.stringify(
    {
      project,
      success: result.success,
      output: result.output,
    },
    null,
    2,
  );
}

export const STUDIO_MODULE_TOOLS: BuiltinToolRegistration[] = [
  {
    name: "omni_studio_list_projects",
    description:
      "列出插件工作台工程（用户目录 plugin-projects，开发态并集扫描仓库 plugins-custom）：名称、来源、kind、版本、文件列表。",
    inputSchema: { type: "object", properties: {} },
    handler: studioListProjects,
  },
  {
    name: "omni_studio_read_file",
    description: "读取插件工程内相对路径文件（禁 ..）。用于查看 plugin.json / logic.js / ui。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "工程目录名（用户目录或仓库 plugins-custom）" },
        path: { type: "string", description: "相对工程根的文件路径，如 plugin.json" },
      },
      required: ["project", "path"],
    },
    handler: studioReadFile,
  },
  {
    name: "omni_studio_write_file",
    description:
      "写入插件工程内相对路径文件（覆盖）。改清单或逻辑后应再调 omni_studio_validate。需用户确认。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "工程目录名" },
        path: { type: "string", description: "相对工程根的文件路径" },
        content: { type: "string", description: "完整文件内容（UTF-8）" },
      },
      required: ["project", "path", "content"],
    },
    handler: studioWriteFile,
  },
  {
    name: "omni_studio_validate",
    description:
      "对插件工程跑清单/结构校验，返回成功与日志。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "工程目录名" },
      },
      required: ["project"],
    },
    handler: studioValidate,
  },
];
