import { useEffect, type FC } from "react";
import { XIcon } from "lucide-react";

import { useI18n } from "../../../i18n";
import { getModuleContextProvider } from "../../../lib/ai/context";
import { resolveFocusModuleKey } from "../../../lib/ai/resolveFocusModuleKey";
import type { DatabaseModuleContext } from "../../../modules/database/ai/types";
import type { DockerModuleContext } from "../../../modules/docker/ai/types";
import {
  type ComposerContextItem,
  useAiComposerContextStore,
} from "../../../stores/aiComposerContextStore";
import { useStatusBarActionBarStore } from "../../../stores/statusBarActionBarStore";
import { useTerminalStore } from "../../../stores/terminalStore";

function kindPrefix(
  kind: ComposerContextItem["kind"],
  t: (key: string) => string,
): string {
  switch (kind) {
    case "terminal":
      return t("ai.composerContext.chipTerminal");
    case "ssh":
      return t("ai.composerContext.chipSsh");
    case "database":
      return t("ai.composerContext.chipDatabase");
    case "docker":
      return t("ai.composerContext.chipDocker");
  }
}

/** 自动上下文条已经展示的当前现场，不再留一颗同内容的显式芯片。 */
function dropChipAlreadyOnStrip(
  items: ComposerContextItem[],
  removeItem: (kind: ComposerContextItem["kind"], id: string) => void,
): void {
  const focus = resolveFocusModuleKey(
    useStatusBarActionBarStore.getState().activeDock?.dockScope ?? null,
  );
  if (focus === "terminal") {
    const activeTabId = useTerminalStore.getState().activeTabId;
    if (activeTabId && items.some((item) => item.kind === "terminal" && item.id === activeTabId)) {
      removeItem("terminal", activeTabId);
    }
    return;
  }
  if (focus === "database") {
    const ctx = getModuleContextProvider("database")?.getContext() as
      | DatabaseModuleContext
      | null
      | undefined;
    const id = ctx?.connection?.id;
    if (id && items.some((item) => item.kind === "database" && item.id === id)) {
      removeItem("database", id);
    }
    return;
  }
  if (focus === "docker") {
    const ctx = getModuleContextProvider("docker")?.getContext() as
      | DockerModuleContext
      | null
      | undefined;
    const id = ctx?.connectionId;
    if (id && items.some((item) => item.kind === "docker" && item.id === id)) {
      removeItem("docker", id);
    }
  }
}

/** Composer 显式多选上下文芯片（可移除）。 */
export const ComposerContextChips: FC = () => {
  const { t } = useI18n();
  const items = useAiComposerContextStore((s) => s.items);
  const removeItem = useAiComposerContextStore((s) => s.removeItem);
  const activeDock = useStatusBarActionBarStore((s) => s.activeDock);
  const activeTabId = useTerminalStore((s) => s.activeTabId);

  useEffect(() => {
    dropChipAlreadyOnStrip(items, removeItem);
  }, [items, removeItem, activeDock, activeTabId]);

  if (items.length === 0) return null;

  return (
    <div className="aui-composer-context-chips flex min-w-0 flex-row flex-nowrap items-center gap-1.5">
      {items.map((item) => (
        <span
          key={`${item.kind}:${item.id}`}
          className="ai-context-chip shrink-0"
          title={`${kindPrefix(item.kind, t)} · ${item.label}`}
        >
          <span className="truncate">
            {kindPrefix(item.kind, t)} · {item.label}
          </span>
          <button
            type="button"
            className="ai-context-chip-remove"
            aria-label={t("ai.composerContext.removeChip", { label: item.label })}
            onClick={() => removeItem(item.kind, item.id)}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
};
