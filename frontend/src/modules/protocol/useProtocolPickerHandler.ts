import { useCallback, useEffect } from "react";
import { useI18n } from "../../i18n";
import type { ProtocolTabKey } from "../../lib/protocolLabConfig";
import {
  registerProtocolPickerSelectHandler,
  type ProtocolPickerContext,
} from "../../stores/protocolTopbarStore";
import { createProtocolSession } from "./createProtocolSession";
import { useProtocolHttpOptional } from "./ProtocolHttpContext";

/** 注册协议选择器回调（须在 ProtocolHttpProvider 内挂载） */
export function useProtocolPickerHandler() {
  const { t } = useI18n();
  const http = useProtocolHttpOptional();

  const handlePickerSelect = useCallback(
    async (protocol: ProtocolTabKey, context: ProtocolPickerContext) => {
      const name = context.sessionName?.trim();
      if (!name) return;
      await createProtocolSession({
        protocol,
        name,
        parentFolderId: context.parentFolderId,
        http: http ?? null,
        t,
      });
    },
    [http, t],
  );

  useEffect(() => {
    registerProtocolPickerSelectHandler(handlePickerSelect);
    return () => registerProtocolPickerSelectHandler(null);
  }, [handlePickerSelect]);
}
