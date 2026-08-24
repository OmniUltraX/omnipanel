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

export type SandboxRequestMethod = "selection.get" | "invoke" | "netFetch" | "overlay.hide";

export type SandboxRequest = {
  __omni: true;
  nonce: string;
  type: "request";
  method: SandboxRequestMethod;
  args: unknown;
};

const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:;">';

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
    overlayHide: function () { return this.request("overlay.hide"); }
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

export function buildSandboxDoc(pluginHtml: string): string {
  // 在 <head> 或文档最前插入 CSP 与桥；无 head 标签时前置拼接
  if (/<head[\s>]/i.test(pluginHtml)) {
    return pluginHtml.replace(/<head([^>]*)>/i, `<head$1>${CSP_META}${PRELUDE}`);
  }
  return `${CSP_META}${PRELUDE}${pluginHtml}`;
}

type Props = {
  pluginId: string;
  title: string;
  html: string;
  onInvoke: (method: "invoke" | "netFetch", args: unknown) => Promise<unknown>;
  onHide: () => void;
};

export function PluginSandboxFrame({ pluginId, title, html, onInvoke, onHide }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const doc = useMemo(() => buildSandboxDoc(html), [html]);

  useEffect(() => {
    async function handleMessage(ev: MessageEvent) {
      const data = ev.data as Partial<SandboxRequest> | undefined;
      if (!data || (data as { __omni?: boolean }).__omni !== true) return;
      if (data.type !== "request") return;
      if (frameRef.current?.contentWindow !== ev.source) return; // 来源校验
      const respond = (result: unknown, error?: string) => {
        frameRef.current?.contentWindow?.postMessage(
          { __omni: true, nonce: data.nonce, type: "response", result, error },
          "*",
        );
      };
      try {
        switch (data.method) {
          case "selection.get": {
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
            respond(await onInvoke("netFetch", data.args));
            break;
          }
          case "overlay.hide": {
            onHide();
            respond(null);
            break;
          }
          default:
            respond(null, `白名单外的方法: ${String(data.method)}`);
        }
      } catch (err) {
        respond(null, String(err));
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onInvoke, onHide]);

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
