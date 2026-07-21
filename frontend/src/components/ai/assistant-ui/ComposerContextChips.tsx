import type { FC } from "react";
import { XIcon } from "lucide-react";

import { useI18n } from "../../../i18n";
import {
  type ComposerContextItem,
  useAiComposerContextStore,
} from "../../../stores/aiComposerContextStore";

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

/** Composer 显式多选上下文芯片（可移除）。 */
export const ComposerContextChips: FC = () => {
  const { t } = useI18n();
  const items = useAiComposerContextStore((s) => s.items);
  const removeItem = useAiComposerContextStore((s) => s.removeItem);

  if (items.length === 0) return null;

  return (
    <div className="aui-composer-context-chips flex w-full flex-row flex-wrap items-center gap-1.5 empty:hidden">
      {items.map((item) => (
        <span
          key={`${item.kind}:${item.id}`}
          className="ai-context-chip"
          title={item.label}
        >
          <span>
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
