import { useCallback } from "react";
import { FormDialog } from "../form/FormDialog";
import { useI18n } from "../../../i18n";
import { usePluginOverlayStore } from "../../../stores/pluginOverlayStore";
import { PluginSandboxFrame } from "../../plugin/PluginSandboxFrame";
import { commands } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";

/** 插件 Overlay 总线宿主：addon 不得自建 WebView；L3 内容经沙箱 iframe 渲染。 */
export function PluginOverlayHost() {
  const { t } = useI18n();
  const entries = usePluginOverlayStore((s) => s.entries);
  const hide = usePluginOverlayStore((s) => s.hide);
  const top = entries[entries.length - 1];

  const handleInvoke = useCallback(
    async (kind: "invoke" | "netFetch", args: unknown) => {
      if (kind === "netFetch") {
        return unwrapCommand(
          commands.pluginSandboxNetFetch(top.pluginId, JSON.stringify(args ?? {})),
        );
      }
      const payload = (args ?? {}) as { method?: string; args?: unknown };
      if (typeof payload.method !== "string") throw new Error("invoke 需要 method");
      return unwrapCommand(
        commands.pluginInvoke(top.pluginId, payload.method, (payload.args ?? null) as never),
      );
    },
    [top.pluginId],
  );

  if (!top) return null;
  return (
    <FormDialog
      open
      title={top.title}
      onClose={() => hide(top.id)}
      primaryAction={{ label: t("common.close"), onClick: () => hide(top.id) }}
    >
      <div style={{ minHeight: 320, minWidth: 480 }}>
        {top.sandboxHtml ? (
          <PluginSandboxFrame
            pluginId={top.pluginId}
            title={top.title}
            html={top.sandboxHtml}
            onInvoke={handleInvoke}
            onHide={() => hide(top.id)}
          />
        ) : (
          <pre className="setting-hint" style={{ whiteSpace: "pre-wrap" }}>
            {top.body}
          </pre>
        )}
      </div>
    </FormDialog>
  );
}
