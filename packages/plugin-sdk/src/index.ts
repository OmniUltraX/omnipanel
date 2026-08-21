import { z } from "zod";

export const pluginKindSchema = z.enum([
  "engine",
  "panel",
  "importer",
  "cloud",
  "module",
  "theme",
  "addon",
]);

export type PluginKind = z.infer<typeof pluginKindSchema>;

export const pluginPermissionSchema = z.enum([
  "vault:read",
  "connections:write",
  "net:connect",
  "ssh:exec",
  "ui:selection",
  "ui:sidebar",
  "ai:tools",
  "fs:read",
]);

export type PluginPermission = z.infer<typeof pluginPermissionSchema>;

export const pluginPlatformSchema = z.enum(["windows", "macos", "linux"]);

export type PluginPlatform = z.infer<typeof pluginPlatformSchema>;

export const aiToolContributionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  execKind: z.enum(["native", "uiDelegated"]).default("native"),
  moduleKey: z.string().default(""),
  crossModule: z.boolean().default(false),
  externalExposed: z.boolean().default(false),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: "object", properties: {} }),
});

export const pluginManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  kind: pluginKindSchema,
  permissions: z.array(pluginPermissionSchema).default([]),
  platforms: z.array(pluginPlatformSchema).optional(),
  contributes: z
    .object({
      ui: z
        .object({
          sidebar: z.boolean().optional(),
          moduleKey: z.string().min(1).optional(),
          connectionForm: z.unknown().optional(),
          panelTabs: z.array(z.unknown()).optional(),
          commands: z.array(z.unknown()).optional(),
          workbench: z
            .object({
              tree: z.enum(["schema", "kv", "collections", "documents", "none"]).optional(),
              editor: z.enum(["sql", "redis", "none"]).optional(),
              preview: z.enum(["grid", "key", "points", "document", "none"]).optional(),
              connectionInfo: z.enum(["sql", "redis", "none"]).optional(),
            })
            .optional(),
        })
        .optional(),
      menus: z.array(z.unknown()).optional(),
      overlays: z.array(z.unknown()).optional(),
      launcher: z.object({ prefix: z.string().min(1) }).optional(),
      discovery: z.array(z.object({ probeId: z.string() })).optional(),
      importers: z.array(z.unknown()).optional(),
      themes: z.object({ tokens: z.unknown().optional() }).optional(),
      ai: z.object({ tools: z.array(aiToolContributionSchema).optional() }).optional(),
      workspace: z.unknown().optional(),
    })
    .default({}),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export type ExternalSource = {
  pluginId: string;
  accountId?: string;
  remoteId: string;
  remoteKind: string;
};

export type ImportCandidate = {
  pluginId: string;
  accountId?: string;
  remoteId: string;
  remoteKind: string;
  name: string;
  config?: unknown;
};

export type HostSelectionSource = "terminal" | "dom" | "editor";

/** 宿主向插件暴露的 Host API（实现由 Runtime 注入；缺权即失败）。 */
export type PluginHost = {
  selection: {
    get: () => { text: string; source: HostSelectionSource } | null;
  };
  connections: {
    upsert: (candidate: ImportCandidate) => Promise<void>;
  };
  invoke: (method: string, args?: unknown) => Promise<unknown>;
  ui: {
    overlay: {
      show: (opts: { id: string; title: string; body: string }) => void;
      hide: (id: string) => void;
    };
  };
};

export function parsePluginManifest(raw: unknown): PluginManifest {
  return pluginManifestSchema.parse(raw);
}
