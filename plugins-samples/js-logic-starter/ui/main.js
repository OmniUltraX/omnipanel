// 第三方动态前端入口约定：CommonJS 风格，module.exports = definePlugin({...})
// 可用全局：definePlugin / host / manifest / module / exports
module.exports = definePlugin({
  activate: async ({ host, manifest }) => {
    if (host && host.ui && host.ui.overlay) {
      // 预留：可在 launcher/菜单中挂载入口，按需调用 host.ui.overlay.show
      void manifest;
    }
  },
  deactivate: () => {},
});
