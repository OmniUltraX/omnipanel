export type ModuleDockOpenMode = "preview" | "permanent";

export type ModuleWorkspaceTab = {
  id: string;
  moduleKey: string;
  connectionId: string;
  capabilityId: string;
  preview?: boolean;
};

export type ModuleSidebarNavTarget = {
  connectionId: string;
  capabilityId: string;
};

export function makeModuleTabId(
  moduleKey: string,
  connectionId: string,
  capabilityId: string,
): string {
  return `module:${moduleKey}:${connectionId}:${capabilityId}`;
}

export function makeModuleTreeKey(target: ModuleSidebarNavTarget): string {
  return `module:${target.connectionId}:${target.capabilityId}`;
}

export function findPreviewModuleTab(tabs: ModuleWorkspaceTab[]): ModuleWorkspaceTab | undefined {
  return tabs.find((tab) => tab.preview);
}

export function findModuleTabId(
  tabs: ModuleWorkspaceTab[],
  moduleKey: string,
  connectionId: string,
  capabilityId: string,
): string | undefined {
  return tabs.find(
    (tab) =>
      tab.moduleKey === moduleKey &&
      tab.connectionId === connectionId &&
      tab.capabilityId === capabilityId,
  )?.id;
}

export function openOrFocusModuleTab(
  tabs: ModuleWorkspaceTab[],
  _activeTabId: string | null,
  mode: ModuleDockOpenMode,
  existingTabId: string | undefined,
  makeTab: (id: string, preview: boolean) => ModuleWorkspaceTab,
): { tabs: ModuleWorkspaceTab[]; activeTabId: string } {
  const previewTab = findPreviewModuleTab(tabs);

  if (mode === "permanent") {
    if (existingTabId) {
      return {
        tabs: tabs.map((tab) => (tab.id === existingTabId ? { ...tab, preview: false } : tab)),
        activeTabId: existingTabId,
      };
    }
    if (previewTab) {
      return {
        tabs: tabs.map((tab) => (tab.id === previewTab.id ? makeTab(previewTab.id, false) : tab)),
        activeTabId: previewTab.id,
      };
    }
    const created = makeTab("", false);
    return { tabs: [...tabs, created], activeTabId: created.id };
  }

  if (existingTabId) {
    const existing = tabs.find((tab) => tab.id === existingTabId);
    if (existing && !existing.preview) {
      return { tabs, activeTabId: existingTabId };
    }
  }

  if (previewTab) {
    return {
      tabs: tabs.map((tab) => (tab.id === previewTab.id ? makeTab(previewTab.id, true) : tab)),
      activeTabId: previewTab.id,
    };
  }

  if (existingTabId) {
    return { tabs, activeTabId: existingTabId };
  }

  const created = makeTab("", true);
  return { tabs: [...tabs, created], activeTabId: created.id };
}

export function reconcileModuleActiveTabId(
  tabs: ModuleWorkspaceTab[],
  activeTabId: string | null,
): string | null {
  if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) return activeTabId;
  return tabs[tabs.length - 1]?.id ?? null;
}
