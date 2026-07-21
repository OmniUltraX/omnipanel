import { useRef, useState, type FC } from "react";
import { PlusIcon } from "lucide-react";
import { ComposerPrimitive } from "@assistant-ui/react";

import { useI18n } from "../../../i18n";
import { ComposerContextMenu } from "./ComposerContextMenu";

/**
 * Composer「+」：附件 + 终端 / SSH / 数据库 / Docker 二级菜单入口。
 */
export const ComposerAddContextButton: FC = () => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const attachTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="composer-add-context">
      <ComposerPrimitive.AddAttachment asChild>
        <button
          ref={attachTriggerRef}
          type="button"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
        />
      </ComposerPrimitive.AddAttachment>
      <button
        ref={triggerRef}
        type="button"
        className="aui-composer-add-attachment composer-add-context__trigger"
        title={t("ai.composerContext.add")}
        aria-label={t("ai.composerContext.add")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <PlusIcon className="aui-attachment-add-icon size-4.5 stroke-[1.5px]" />
      </button>
      <ComposerContextMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        onPickAttachment={() => attachTriggerRef.current?.click()}
      />
    </div>
  );
};
