## 1. 识别与分类（纯函数）

- [x] 1.1 扩展 `frontend/src/modules/terminal/terminalFileLinks.ts`：修正/补齐路径正则；增加裸名分词；`ls -F` 后缀剥离；目录色启发式。验证：新增 `terminalFileLinks.test.ts`（vitest）覆盖路径、裸名、误链 `error`
- [x] 1.2 增加 kind 判定入口（缓存命中 > `-F` > 颜色 > 路径正则），输出 `{ text, start, end, absolutePath, kind }`。验证：目录带尾 `/` 为 dir，文件为 file
- [x] 1.4 提示符 cwd 按 `/` 或 `\` 分段为目录链接（`~` 展开为 home）。验证：`root@localhost:~/a/b#` 的 `~`/`a`/`b` 均为 dir；正文 `/etc/hosts` 仍为 file
- [x] 1.3 ILink 坐标改为使用 `bufferLineNumber`（在 provider 组装处，见 3.x）。验证：单测构造 range.y 不为 1

## 2. cwd 列举缓存复用

- [x] 2.1 复用 `frontend/src/modules/terminal/commandBar/pathListingCache.ts`（及现有 `sftpList` / `listDirectory`，IPC 走 `bindings`）：cwd 变化时 debounce 预取，禁止在 `provideLinks` 里打 IPC。验证：缓存命中后裸名可查出 kind
- [x] 2.2 直连 pane 在 `fileLink.cwd` 更新时触发预取（`useTerminal.ts` 或独立小 hook）。验证：切换目录后新名字可点、旧 cwd 名字不再误用

## 3. ILinkProvider 接通动作

- [x] 3.1 改造 `frontend/src/modules/terminal/useTerminalFileLinkProvider.ts`：传入 `sendCommand`、空闲判定、鼠标跟踪检测；目录走 `terminalCdCommand`，文件走 `tryOpenTerminalFilePreview`；不再跳过 `endsWith("/")` 的目录。验证：单元/浅测 activate 分流
- [x] 3.2 `frontend/src/hooks/useTerminal.ts`：`enabled` 仅在 `inputMode === "interactive"` 且有 `fileLink` 时为 true；把 send / prompt 空闲线索传给 provider。验证：命令栏 `external` 非 live-native 不注册有效链接
- [x] 3.3 鼠标跟踪开启时 `provideLinks` 返回空。验证：模拟 mouse mode 时无链接
- [x] 3.4 前台忙时点目录只 toast、不写 PTY；文案走 i18n（`zh-CN` / `en-US`）。验证：忙/闲两条路径

## 4. 联调与回归

- [ ] 4.1 手动：本地直连 `ls` → 点目录 cd、点文本文件预览；SSH 直连同样走一遍
- [ ] 4.2 手动：`vim` / `htop` 开鼠标后点击不被路径链接抢走；命令栏 `ls` 卡片点击仍可用
- [x] 4.3 `cd frontend && npx tsc -b`；相关 vitest 全绿

