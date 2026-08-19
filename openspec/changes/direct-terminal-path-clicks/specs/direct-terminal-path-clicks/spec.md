## ADDED Requirements

### Requirement: 直连终端启用路径左键链接
系统 MUST 仅在终端 `effectiveInputMode` 为 `interactive`（含 live-native xterm）时，向该 pane 的 xterm 注册文件/目录 `ILinkProvider`。命令栏 Warp feed 的 `LsListingView` 行为 MUST 保持不变。

#### Scenario: 直连模式可点
- **GIVEN** 用户处于直连终端（非命令栏 feed）
- **WHEN** 输出中出现可识别的文件或目录 token
- **THEN** 悬停显示链接样式，左键触发对应动作

#### Scenario: 命令栏 feed 不走 xterm 链接
- **GIVEN** 用户处于命令栏模式且 xterm 不是 live-native 主表面
- **WHEN** `ls` 结果以 `LsListingView` 渲染
- **THEN** 点击仍由既有 HTML 条目处理，不依赖本 ILinkProvider

### Requirement: 点击目录发送 cd
系统 MUST 在用户左键点击被识别为目录（含可进入的 symlink）的链接时，向当前 PTY 发送与命令栏相同语义的 `cd` 命令（`terminalCdCommand`）。系统 MUST NOT 在检测到命令正在运行或当前屏幕不像空闲 shell 提示符时写入该 `cd`。

#### Scenario: 空闲时进入目录
- **GIVEN** 直连会话停在 shell 提示符且 cwd 已知
- **WHEN** 用户点击 `ls` 中的目录名
- **THEN** PTY 收到对该绝对路径的 `cd`，会话 cwd 随后更新

#### Scenario: 前台命令运行中不注入 cd
- **GIVEN** PTY 上有前台命令（非空闲提示符）
- **WHEN** 用户点击目录链接
- **THEN** 系统不向 PTY 写入 `cd`，并提示用户当前无法切换目录

### Requirement: 点击文件打开预览
系统 MUST 在用户左键点击被识别为文件的链接时调用既有 `tryOpenTerminalFilePreview`（含类型/大小门禁）。系统 MUST NOT 为打开预览向 PTY 写入命令。

#### Scenario: 文本文件预览
- **GIVEN** 直连会话输出中有可预览文件路径或缓存命中的文件名
- **WHEN** 用户左键点击该链接
- **THEN** 打开终端文件预览窗；PTY 输入流不被写入

#### Scenario: 不支持类型被门禁拦截
- **GIVEN** 文件名被判定为不支持预览
- **WHEN** 用户点击该链接
- **THEN** 不打开预览窗，并按既有预览门禁提示用户

### Requirement: 提示符 cwd 分段可点
系统 MUST 将 shell 提示符中展示的 cwd（如 `user@host:~/a/b#`、`PS C:\a\b>`）按路径分隔符拆成独立目录链接；左键某段 MUST 对该段对应的绝对路径发送与其它目录链接相同的 `cd`。系统 MUST NOT 把整段提示符 cwd 当成文件预览。提示符之后的正文路径链接 MUST 仍可识别。

#### Scenario: bash 提示符面包屑
- **GIVEN** 直连会话停在 `root@localhost:~/cache/mango/mood-calendar-service#`
- **WHEN** 用户分别点击 `~`、`cache`、`mango`
- **THEN** 依次 `cd` 到 home、`…/cache`、`…/cache/mango`（可附带自动 ls），而不是打开文件预览

#### Scenario: 提示符后的正文路径仍可点
- **GIVEN** 屏幕行为 `root@localhost:~/cache# cat /etc/hosts`
- **WHEN** 用户点击正文中的 `/etc/hosts`
- **THEN** 按文件预览处理；点击提示符里的 `cache` 仍按目录 `cd`

### Requirement: 裸文件名依赖目录缓存
系统 MUST 将空白分词得到的裸文件名做成链接，当且仅当该名字命中当前 cwd 的目录列举缓存（或 `ls -F` 后缀 / 目录色给出明确 kind）。系统 MUST NOT 在缓存未命中时把普通英文单词做成链接。带 `/` 或盘符的路径 token MUST 仍可按路径正则识别。

#### Scenario: ls 网格中的名字可点
- **GIVEN** cwd 列举缓存已包含 `README.md` 与 `src`
- **WHEN** 直连 xterm 显示 `ls` 网格且其中有上述名字
- **THEN** 两者均可悬停成为链接，`src` 按目录、`README.md` 按文件处理

#### Scenario: 缓存未就绪不误链
- **GIVEN** cwd 列举尚未返回
- **WHEN** 屏幕上出现单词 `error`
- **THEN** 该单词不是路径链接；`/var/log/syslog` 仍可作为路径链接

### Requirement: 链接坐标与鼠标协议
系统 MUST 使用 `provideLinks` 的 buffer 行号作为 ILink 的 `y` 坐标。系统 MUST 在 xterm 鼠标跟踪模式开启时不提供路径链接。

#### Scenario: 多行输出点击落在正确行
- **GIVEN** 可点路径出现在 scrollback 中第 N 行
- **WHEN** 用户点击该行上的路径
- **THEN** 激活的是该行对应条目，而不是 buffer 第一行

#### Scenario: vim 鼠标模式让路
- **GIVEN** 全屏应用已开启 DEC 鼠标跟踪
- **WHEN** 用户在该界面点击
- **THEN** 路径 ILinkProvider 不拦截该点击

### Requirement: 无新凭据与生产写路径
路径点击 MUST NOT 新增凭据存储，MUST NOT 绕过既有预览门禁去下载或改写远端文件。目录 `cd` MUST 仅由用户左键显式触发。

#### Scenario: 预览走只读既有通道
- **GIVEN** 远程 SSH 会话
- **WHEN** 用户点击文件链接且通过预览门禁
- **THEN** 预览使用既有 SFTP/本地读取通道，不新增 IPC 命令，不写入远端文件
