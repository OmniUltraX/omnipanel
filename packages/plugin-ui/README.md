# @omnipanel/plugin-ui

第一方插件可用的稳定 UI 面。只再导出宿主 `components/ui` 中已冻结的组件。

**禁止**在插件代码中 `import` `frontend/src/modules/*`。业务面板、连接对话框、云厂商页属于 Host 壳，不走本包。

允许：`Button`、`TextInput`、`Dialog`（`FormDialog`）、空态 `ModuleEmptyState`。
