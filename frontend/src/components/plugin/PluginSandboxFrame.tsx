import { useEffect, useMemo, useRef } from "react";

/**
 * L3 插件沙箱 iframe：
 * - sandbox="allow-scripts"（无 allow-same-origin → 不透明 origin，无法触达宿主 DOM/存储）；
 * - srcdoc 内嵌 CSP `<meta http-equiv="Content-Security-Policy" default-src 'none'>` +
 *   宿主 prelude（postMessage 桥），插件 HTML 随后注入；
 * - 消息协议：guest→host `{ __omni: true, nonce, type: "request", method, args }`；
 *   host→guest `{ __omni: true, nonce, type: "response" | "error", result?|error? }`。
 *   白名单方法在宿主侧逐条过权限闸。
 */

export type SandboxRequestMethod =
  | "selection.get"
  | "invoke"
  | "netFetch"
  | "overlay.hide"
  | "aiComplete"
  | "overlayInitial";

export type SandboxRequest = {
  __omni: true;
  nonce: string;
  type: "request";
  method: SandboxRequestMethod;
  args: unknown;
};

const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:;">';

/**
 * 沙箱主题基座（通用）：宿主设计 token 的静态镜像 + 原生风基元素样式。
 * iframe 与宿主文档隔离、拿不到宿主 CSS 变量，打开时由宿主按当前
 * `data-theme` 选中一支。插件 HTML 直接用 var(--fg) 等变量即跟随主题，
 * button/select/input/textarea 开箱即用，无需各插件重复造样式。
 */
const THEME_STYLE = `
<style>
:root{
  color-scheme:dark;
  --bg:#201d1d;--bg-deeper:#1a1717;--surface:#302c2c;--surface-hover:#3a3636;--surface-active:#444040;
  --fg:#ffffff;--fg-2:#e8e8ed;--muted:#a1a1a6;--meta:#8e8e93;
  --border:#464343;--border-soft:#302c2c;--border-focus:#007aff;
  --accent:#007aff;--accent-hover:#0056b3;--accent-soft:rgba(0,122,255,.12);
  --success:#30d158;--warn:#ff9f0a;--danger:#ff3b30;
  --r-sm:4px;--r-md:6px;--r-lg:8px;
}
:root[data-theme="light"]{
  color-scheme:light;
  --bg:#f5f5f7;--bg-deeper:#e8e8ed;--surface:#ffffff;--surface-hover:#f0f0f2;--surface-active:#e5e5ea;
  --fg:#1d1d1f;--fg-2:#3a3a3c;--muted:#636366;--meta:#8e8e93;
  --border:#d2d2d7;--border-soft:#e8e8ed;--border-focus:#007aff;
  --accent:#007aff;--accent-hover:#0056b3;--accent-soft:rgba(0,122,255,.1);
  --success:#34c759;--warn:#ff9500;--danger:#ff3b30;
}
html,body{margin:0;padding:0;background:var(--surface);color:var(--fg);}
body{font:13px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;padding:12px 14px;}
.omni-plugin button,.omni-plugin select,.omni-plugin input,.omni-plugin textarea,
button.omni,select.omni,input.omni,textarea.omni,
body button,body select,body input,body textarea{
  font:inherit;color:var(--fg-2);background:transparent;
  border:1px solid var(--border);border-radius:var(--r-md);
}
body button,body select{padding:4px 10px;cursor:pointer;}
body button:hover:not(:disabled),body select:hover:not(:disabled){color:var(--accent);border-color:var(--accent);}
body button:disabled{opacity:.5;cursor:default;}
body input,body textarea{padding:6px 8px;background:var(--bg-deeper);}
body input:focus,body textarea:focus,body select:focus,body button:focus-visible{outline:none;border-color:var(--border-focus);}
body select option{background:var(--surface);color:var(--fg);}
.omni-muted{color:var(--muted);font-size:12px;}
.omni-card{border:1px solid var(--border-soft);border-radius:var(--r-lg);padding:8px 10px;background:var(--bg-deeper);}
.omni-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
.omni-status{font-size:12px;color:var(--meta);min-height:18px;margin-top:8px;}
</style>
`;

const PRELUDE = `
<script>
(function () {
  var seq = 0;
  var pending = {};
  window.host = {
    request: function (method, args) {
      return new Promise(function (resolve, reject) {
        var nonce = "n" + ++seq + "-" + Math.random().toString(36).slice(2, 8);
        pending[nonce] = { resolve: resolve, reject: reject };
        parent.postMessage(
          { __omni: true, nonce: nonce, type: "request", method: method, args: args === undefined ? null : args },
          "*"
        );
      });
    },
    selectionGet: function () { return this.request("selection.get"); },
    invoke: function (method, args) { return this.request("invoke", { method: method, args: args }); },
    netFetch: function (spec) { return this.request("netFetch", spec); },
    overlayHide: function () { return this.request("overlay.hide"); },
    aiComplete: function (spec) { return this.request("aiComplete", spec); },
    overlayInitial: function () { return this.request("overlayInitial"); }
  };
  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!data || data.__omni !== true || data.type !== "response") return;
    var p = pending[data.nonce];
    if (!p) return;
    delete pending[data.nonce];
    if (data.type === "response") {
      if (data.error) p.reject(new Error(String(data.error)));
      else p.resolve(data.result);
    }
  });
})();
</script>
`;

export type SandboxTheme = "dark" | "light";

export function buildSandboxDoc(pluginHtml: string, theme: SandboxTheme = "dark"): string {
  // 在 <head> 或文档最前插入 CSP、主题基座与桥；无 head 标签时前置拼接。
  // light 主题多一段脚本把 data-theme 打到 <html> 上（dark 为缺省，无需设置）。
  const themeScript =
    theme === "light"
      ? '<script>document.documentElement.dataset.theme="light";</script>'
      : "";
  const head = `${CSP_META}${THEME_STYLE}${PRELUDE}${themeScript}`;
  if (/<head[\s>]/i.test(pluginHtml)) {
    return pluginHtml.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  }
  return `${head}${pluginHtml}`;
}

type Props = {
  pluginId: string;
  title: string;
  html: string;
  theme: SandboxTheme;
  onInvoke: (method: "invoke" | "netFetch", args: unknown) => Promise<unknown>;
  onHide: () => void;
};

export function PluginSandboxFrame({ pluginId, title, html, theme, onInvoke, onHide }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const doc = useMemo(() => buildSandboxDoc(html, theme), [html, theme]);

  useEffect(() => {
    async function handleMessage(ev: MessageEvent) {
      const data = ev.data as Partial<SandboxRequest> | undefined;
      if (!data || (data as { __omni?: boolean }).__omni !== true) return;
      if (data.type !== "request") return;
      if (frameRef.current?.contentWindow !== ev.source) return; // 来源校验
      if (typeof data.nonce !== "string" || !data.nonce) return; // nonce 必填
      const respond = (result: unknown, error?: string) => {
        frameRef.current?.contentWindow?.postMessage(
          { __omni: true, nonce: data.nonce, type: "response", result, error },
          "*",
        );
      };
      // 白名单外一律拒绝并审计（action=plugin.bridge.blocked 经权限拒绝路径落 audit）
      const deny = async (permission: string, message: string) => {
        try {
          const { commands } = await import("../../ipc/bindings");
          const { unwrapCommand } = await import("../../ipc/result");
          await unwrapCommand(commands.pluginRequirePermission(pluginId, permission)).catch(
            () => null,
          );
        } catch {
          /* audit 尽力而为 */
        }
        console.error(`[plugin-bridge] blocked ${pluginId} ${String(data.method)}: ${message}`);
        respond(null, message);
      };
      try {
        const { getPluginManifest } = await import("../../lib/pluginManifests");
        const manifest = getPluginManifest(pluginId);
        const granted = new Set(manifest?.permissions ?? []);
        switch (data.method) {
          case "selection.get": {
            if (!granted.has("ui:selection")) {
              await deny("ui:selection", "缺权限 ui:selection");
              break;
            }
            const { getHostSelection } = await import("../../lib/hostSelection");
            respond(getHostSelection());
            break;
          }
          case "invoke": {
            const args = (data.args ?? {}) as { method?: string; args?: unknown };
            if (typeof args.method !== "string") throw new Error("invoke 需要 method");
            respond(await onInvoke("invoke", args));
            break;
          }
          case "netFetch": {
            if (!granted.has("net:connect")) {
              await deny("net:connect", "缺权限 net:connect");
              break;
            }
            respond(await onInvoke("netFetch", data.args));
            break;
          }
          case "overlay.hide": {
            onHide();
            respond(null);
            break;
          }
          case "aiComplete": {
            if (!granted.has("ai:tools")) {
              await deny("ai:tools", "缺权限 ai:tools");
              break;
            }
            const { createPluginHost } = await import("../../lib/pluginHost");
            respond(await createPluginHost(pluginId).ai.complete((data.args ?? {}) as never));
            break;
          }
          case "overlayInitial": {
            const { usePluginOverlayStore } = await import("../../stores/pluginOverlayStore");
            const entries = usePluginOverlayStore
              .getState()
              .entries.filter((item) => item.pluginId === pluginId);
            respond(entries[entries.length - 1]?.initialText ?? null);
            break;
          }
          default:
            await deny("ui:selection", `白名单外的方法: ${String(data.method)}`);
        }
      } catch (err) {
        respond(null, String(err));
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [pluginId, onInvoke, onHide]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      data-plugin-id={pluginId}
      sandbox="allow-scripts"
      srcDoc={doc}
      style={{ width: "100%", height: "100%", border: "none", background: "transparent" }}
    />
  );
}
