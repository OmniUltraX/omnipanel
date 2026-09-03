import { isPluginActivated, usePluginRuntimeStore } from "../../../stores/pluginRuntimeStore";
import {
  getPluginManifest,
  listPluginManifests,
  manifestPanelTabIds,
} from "../../../lib/pluginManifests";
import { pluginDisplayName } from "../../plugins/pluginDisplayName";
import type { PanelTabDecl } from "@omnipanel/plugin-sdk";

export const PLUGIN_ID_PANEL_1PANEL = "omni.panel.1panel";
export const PLUGIN_ID_PANEL_BT = "omni.panel.bt";

export type PanelCapability =
  | "overview"
  | "websites"
  | "apps"
  | "certificates"
  | "cronjobs"
  | "databases";

const ALIASES: Record<string, string> = {
  bt: PLUGIN_ID_PANEL_BT,
  baota: PLUGIN_ID_PANEL_BT,
  [PLUGIN_ID_PANEL_BT]: PLUGIN_ID_PANEL_BT,
  "1panel": PLUGIN_ID_PANEL_1PANEL,
  onepanel: PLUGIN_ID_PANEL_1PANEL,
  [PLUGIN_ID_PANEL_1PANEL]: PLUGIN_ID_PANEL_1PANEL,
};

function livePanelTabIds(pluginId: string): string[] {
  return manifestPanelTabIds(livePanelManifest(pluginId));
}

export function canonicalPanelPluginId(serviceType: string | null | undefined): string {
  const raw = (serviceType ?? "").trim().toLowerCase();
  if (!raw) return PLUGIN_ID_PANEL_BT;
  return ALIASES[raw] ?? raw;
}

/** Host upsert 与预览层共用：legacy `1panel`/`bt` 与插件 id 等价。 */
export function panelCandidateMatches(
  conn: { kind?: string; config?: string | null },
  candidate: {
    pluginId: string;
    accountId?: string | null;
    remoteKind: string;
    config?: unknown;
  },
): boolean {
  if (conn.kind !== "panel" || candidate.remoteKind !== "panel") return false;
  let cfg: { sshConnectionId?: unknown; serviceType?: unknown } = {};
  try {
    cfg = JSON.parse(conn.config || "{}") as typeof cfg;
  } catch {
    return false;
  }
  const sshId =
    (typeof candidate.accountId === "string" && candidate.accountId) ||
    (candidate.config &&
    typeof candidate.config === "object" &&
    !Array.isArray(candidate.config) &&
    typeof (candidate.config as { sshConnectionId?: unknown }).sshConnectionId === "string"
      ? (candidate.config as { sshConnectionId: string }).sshConnectionId
      : "");
  if (!sshId || cfg.sshConnectionId !== sshId) return false;
  return canonicalPanelPluginId(typeof cfg.serviceType === "string" ? cfg.serviceType : "") ===
    canonicalPanelPluginId(candidate.pluginId);
}

/** 持久化用插件 id；读旧连接时把 bt/1panel 升格。 */
export function panelServiceTypeToPluginId(serviceType: string): string {
  return canonicalPanelPluginId(serviceType);
}

export function isOnePanelService(serviceType: string | null | undefined): boolean {
  return canonicalPanelPluginId(serviceType) === PLUGIN_ID_PANEL_1PANEL;
}

export function isBtPanelService(serviceType: string | null | undefined): boolean {
  return canonicalPanelPluginId(serviceType) === PLUGIN_ID_PANEL_BT;
}

export function isFirstPartyPanelService(serviceType: string | null | undefined): boolean {
  return isOnePanelService(serviceType) || isBtPanelService(serviceType);
}

function livePanelManifest(pluginId: string) {
  return (
    getPluginManifest(pluginId) ??
    listPluginManifests("panel").find((item) => item.id === pluginId) ??
    null
  );
}

/** 第三方是否在清单里声明了该 L2 方法（第一方走进程内客户端，不看这个）。 */
export function panelDeclaresMethod(
  serviceType: string | null | undefined,
  method: string,
): boolean {
  const id = canonicalPanelPluginId(serviceType);
  return (livePanelManifest(id)?.methods ?? []).some((item) => item.name === method);
}

export function panelHasCapability(
  serviceType: string | null | undefined,
  capability: PanelCapability,
): boolean {
  const id = canonicalPanelPluginId(serviceType);
  const hydrated = usePluginRuntimeStore.getState().hydrated;
  if (hydrated && !isPluginActivated(id)) return false;
  return livePanelTabIds(id).includes(capability);
}

const DEFAULT_PANEL_LIST_METHODS: Record<string, string> = {
  databases: "listDatabases",
  websites: "listWebsites",
  certificates: "listCertificates",
  cronjobs: "listCronjobs",
  apps: "listApps",
};

const DEFAULT_PANEL_CREATE_METHODS: Record<string, string> = {
  databases: "createDatabase",
  websites: "createWebsite",
  certificates: "createCertificate",
  cronjobs: "createCronjob",
  apps: "installApp",
};

function asPanelTabDecl(raw: unknown): PanelTabDecl | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as {
    id?: unknown;
    listMethod?: unknown;
    formFields?: unknown;
    actions?: unknown;
  };
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) return null;
  const formFields = Array.isArray(rec.formFields)
    ? rec.formFields.filter(
        (field): field is { key: string; label?: string } =>
          Boolean(field) &&
          typeof field === "object" &&
          typeof (field as { key?: unknown }).key === "string" &&
          Boolean((field as { key: string }).key.trim()),
      )
    : undefined;
  const actions = Array.isArray(rec.actions)
    ? rec.actions.filter(
        (action): action is NonNullable<PanelTabDecl["actions"]>[number] =>
          Boolean(action) &&
          typeof action === "object" &&
          typeof (action as { id?: unknown }).id === "string" &&
          typeof (action as { method?: unknown }).method === "string",
      )
    : undefined;
  return {
    id,
    listMethod: typeof rec.listMethod === "string" ? rec.listMethod.trim() || undefined : undefined,
    formFields,
    actions,
  };
}

export function panelTabDecl(
  serviceType: string | null | undefined,
  tabId: string,
): PanelTabDecl | null {
  const id = canonicalPanelPluginId(serviceType);
  const tabs = livePanelManifest(id)?.contributes.ui?.panelTabs ?? [];
  for (const tab of tabs) {
    const decl = asPanelTabDecl(tab);
    if (decl?.id === tabId) return decl;
  }
  return null;
}

export type PanelTabCreateSpec = {
  method: string;
  formFields: Array<{ key: string; label?: string }>;
  label?: string;
};

/** 清单 actions.create + formFields 才走通用表单；否则 Host 看进程内 driver 开富弹窗。 */
export function panelTabCreateSpec(
  serviceType: string | null | undefined,
  tabId: string,
): PanelTabCreateSpec | null {
  const tab = panelTabDecl(serviceType, tabId);
  if (!tab) return null;
  const createAction = (tab.actions ?? []).find(
    (action) =>
      action.id === "create" ||
      action.id === "install" ||
      ((action.target === "toolbar" || !action.target) &&
        /^(create|install)/i.test(action.method)),
  );
  const fallback = DEFAULT_PANEL_CREATE_METHODS[tabId] ?? "";
  const method =
    createAction?.method?.trim() ||
    (fallback && panelDeclaresMethod(serviceType, fallback) ? fallback : "");
  if (!method) return null;
  if (tabId === "apps") {
    return { method, formFields: tab.formFields ?? [], label: createAction?.label };
  }
  const formFields = tab.formFields ?? [];
  if (formFields.length === 0) return null;
  return { method, formFields, label: createAction?.label };
}

export function panelTabListMethod(
  serviceType: string | null | undefined,
  tabId: string,
): string | null {
  const tab = panelTabDecl(serviceType, tabId);
  const named = tab?.listMethod?.trim();
  if (named) return named;
  return DEFAULT_PANEL_LIST_METHODS[tabId] ?? null;
}

export function panelVendorLabelKey(serviceType: string | null | undefined): "bt" | "1panel" | "other" {
  if (isBtPanelService(serviceType)) return "bt";
  if (isOnePanelService(serviceType)) return "1panel";
  return "other";
}

/** i18n：`server.serviceType.bt` / `server.serviceType.1panel` */
export function panelServiceTypeI18nKey(serviceType: string | null | undefined): "bt" | "1panel" {
  return isOnePanelService(serviceType) ? "1panel" : "bt";
}

export function panelServiceTypeLabel(
  serviceType: string | null | undefined,
  t: (key: string) => string,
): string {
  const id = canonicalPanelPluginId(serviceType);
  if (id === PLUGIN_ID_PANEL_BT) return t("server.serviceType.bt");
  if (id === PLUGIN_ID_PANEL_1PANEL) return t("server.serviceType.1panel");
  return pluginDisplayName(id, t);
}
