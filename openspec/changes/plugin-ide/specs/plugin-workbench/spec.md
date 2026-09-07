## ADDED Requirements

### Requirement: 工程面板一条龙

`/studio` SHALL 提供：工程列表（`plugins-custom/` 扫描）、Monaco 文件编辑、校验/打包/本地安装一键执行（日志流回显）、本机工具链检测（cargo/node/wat2wasm，缺失给引导而非报错）。

#### Scenario: 从零到装上

- **WHEN** 用户新建工程、改两行、点校验、点打包、点安装
- **THEN** 全程不出 OmniPanel，最终走权限确认框装上可用

#### Scenario: 缺工具链不断头

- **WHEN** 本机无 cargo
- **THEN** 打包按钮置灰并给出安装引导，面板其它功能照常

### Requirement: 受控脚本执行

后端 SHALL 只允许三条固定脚本命令（validate/pack/版本探测），路径禁锢在 `plugins-custom/` 内；输出 SHALL 流式回显到运行日志。

#### Scenario: 越界拒绝

- **WHEN** 请求读写工程目录外的文件
- **THEN** 拒绝并报路径越界，不执行
