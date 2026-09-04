// 第三方选中翻译插件：纯 L1 清单 + 动态前端入口（ui/main.js），零后端代码。
// 链路：选中文字 → 悬浮"译"按钮 → 点击 → 打开本插件 L3 overlay →
// overlay 内经 host.aiComplete 调宿主 AI（prompt 自控）出译文。
//
// 合约：CommonJS 风格，module.exports = definePlugin({ activate, deactivate })；
// 可用全局：definePlugin / host / manifest / module / exports。
// deactivate MUST 卸除本次 activate 登记的一切（菜单项）。

var MENU_ID = "translate-float";
var cachedHost = null;

module.exports = definePlugin({
  activate: async function (ctx) {
    cachedHost = ctx.host;
    ctx.host.ui.menu.register({
      id: MENU_ID,
      // 中英双语 label：悬浮按钮 title 与右键菜单共用
      label: "翻译选中文字 Translate selection",
      when: { hasSelection: true },
      // opt-in 悬浮按钮：1 字图标
      float: { icon: "译" },
      onClick: async function (menuCtx) {
        var text = (menuCtx && menuCtx.selectionText) || "";
        if (!text.trim()) return;
        // 带参打开：点击会收起选区，文本必须此时传给 overlay
        await ctx.host.ui.overlay.open("translator", { text: text });
      },
    });
  },
  deactivate: function () {
    if (cachedHost) {
      try {
        cachedHost.ui.menu.unregister(MENU_ID);
      } catch (e) {
        void e;
      }
      cachedHost = null;
    }
  },
});
