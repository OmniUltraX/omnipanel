import { forwardRef, useMemo, useState } from "react";
import { TextEditorPanel } from "@/components/textEditor";
import type { TextEditorHandle, TextEditorIO } from "@/components/textEditor";
import { createBtPanelClient } from "@/lib/btpanel";
import { createOnePanelClient } from "@/lib/onepanel";
import { useI18n } from "@/i18n";
import type { ServerEntry } from "./serverConnection";
import { isBtPanelService, isOnePanelService } from "./panelPlugin";

type WebsiteConfigEditorPaneProps = {
  open: boolean;
  enabled: boolean;
  server: ServerEntry;
  websiteId: number | null;
  siteName?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveSuccess?: () => void;
};

/** 编辑弹窗内嵌的网站 Nginx/OpenResty 配置编辑器。 */
export const WebsiteConfigEditorPane = forwardRef<
  TextEditorHandle,
  WebsiteConfigEditorPaneProps
>(function WebsiteConfigEditorPane(
  { open, enabled, server, websiteId, siteName = null, onDirtyChange, onSaveSuccess },
  ref,
) {
  const { t } = useI18n();
  const [subtitle, setSubtitle] = useState("");

  const io = useMemo<TextEditorIO | null>(() => {
    if (!open) return null;
    if (isBtPanelService(server.serviceType)) {
      if (!siteName) return null;
      const client = createBtPanelClient(server.address, server.key, server.id);
      return {
        async readText() {
          const file = await client.getNginxConfig(siteName);
          setSubtitle(file.path);
          return file.content;
        },
        async writeText(text: string) {
          await client.saveNginxConfig(siteName, text);
        },
      };
    }
    if (websiteId == null || !isOnePanelService(server.serviceType)) return null;
    const client = createOnePanelClient(
      server.address,
      server.key,
      server.id,
      server.panelUser,
    );
    return {
      async readText() {
        const file = await client.getWebsiteConfig(websiteId, "openresty");
        setSubtitle(typeof file.path === "string" ? file.path : "");
        return typeof file.content === "string" ? file.content : "";
      },
      async writeText(text: string) {
        await client.updateWebsiteNginx(websiteId, text);
      },
    };
  }, [open, server, websiteId, siteName]);

  if (!io) {
    return <p className="form-hint">{t("server.websites.panelOnly")}</p>;
  }

  return (
    <div className="server-edit-website-config">
      {subtitle ? <p className="form-hint server-edit-website-config__path">{subtitle}</p> : null}
      <div className="server-edit-website-config__editor">
        <TextEditorPanel
          ref={ref}
          io={io}
          enabled={enabled}
          language="nginx"
          editable
          onDirtyChange={onDirtyChange}
          onSaveSuccess={onSaveSuccess}
          contentResetKey={subtitle || `${server.id}:${websiteId ?? siteName ?? ""}`}
          className="server-edit-website-config__preview"
        />
      </div>
    </div>
  );
});
