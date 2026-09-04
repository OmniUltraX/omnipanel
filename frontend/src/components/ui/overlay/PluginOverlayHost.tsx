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
  const pluginId = top?.pluginId;

  const handleInvoke = useCallback(
    async (kind: "invoke" | "netFetch", args: unknown) => {
      if (!pluginId) throw new Error("overlay closed");
      if (kind === "netFetch") {
        return unwrapCommand(
          commands.pluginSandboxNetFetch(pluginId, JSON.stringify(args ?? {})),
        );
      }
      const payload = (args ?? {}) as { method?: string; args?: unknown };
      if (typeof payload.method !== "string") throw new Error("invoke 需要 method");
      return unwrapCommand(
        commands.pluginInvoke(pluginId, payload.method, (payload.args ?? null) as never),
      );
    },
    [pluginId],
  );

  if (!top) return null;
  const theme =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light"
      ? "light"
      : "dark";
  return (
    <FormDialog
      open
      title={top.title}
      onClose={() => hide(top.id)}
      primaryAction={{ label: t("common.close"), onClick: () => hide(top.id) }}
    >
      <div
        style={{
          // 定高（非 minHeight）：iframe 的 height:100% 相对 auto 高父容器会塌陷成
          // 默认 150px，导致内容在小框里滚、下面留大片空白。定高后 iframe 沾满，
          // 无多余滚动条；宽度用 100% 而非 minWidth，避免顶满撑出横向滚动条。
          height: 430,
          width: "100%",
          overflow: "hidden",
        }}
      >
        {top.sandboxHtml ? (
          <PluginSandboxFrame
            pluginId={top.pluginId}
            title={top.title}
            html={top.sandboxHtml}
            theme={theme}
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
