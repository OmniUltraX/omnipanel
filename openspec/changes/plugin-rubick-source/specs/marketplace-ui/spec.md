# Marketplace UI（delta）

## ADDED Requirements

### Requirement: 第三方来源展示与分级安装

市场 SHALL 支持按来源筛选并以 badge 标注第三方（含 rubick）；安装按钮 SHALL 按 verdict 分级：一键转换安装（runnable）/ 外跳（external-only）；compat 报告 SHALL inline 展示 reasons；文案 SHALL 中英同次。

#### Scenario: 筛选第三方源

- **WHEN** 用户选择来源筛选为 rubick
- **THEN** 仅展示该源插件，每项带第三方 badge 与 npm 包名

#### Scenario: 分级安装按钮

- **WHEN** 条目 verdict=runnable
- **THEN** 主按钮为一键转换安装；verdict=external-only 时主按钮为外跳并附原因
