# OmniPanel Web — Docker 部署与验证

> Docker Web **0.8.59** 与桌面 `v0.8.59` 同源发布，跟踪标签 `docker-v0.8.59`。不修改已发布的桌面 `v0.8.57` / `v0.8.58` 标签或资产、`docker-v0.8.57` / `docker-v0.8.58` 或镜像标签 `0.8.57` / `0.8.58`。以 [Docker 工作流](https://github.com/OmniUltraX/omnipanel/actions/workflows/docker-web.yml) 的发布/匿名拉取校验成功为准；不要把桌面发布、仅构建成功或旧 `latest` 当成新镜像已发布。生产应固定版本及 digest。

```bash
docker pull ghcr.io/omniultrax/omnipanel-web:0.8.59
# 检查镜像 org.opencontainers.image.version / revision，并保留发布 digest。
```

## 从源码构建（无发布）

```bash
docker build -f deploy/docker/Dockerfile \
  --build-arg OMNIPANEL_VERSION=local \
  --build-arg OMNIPANEL_REVISION=uncommitted \
  -t omnipanel-web:local .
docker build -f deploy/docker/Dockerfile --target rust-tests .
python3 scripts/test-docker-context.py
python3 scripts/smoke-docker-web.py omnipanel-web:local
```

若构建环境的 DNS 代理无法处理 Debian SRV 记录，可加 `--build-arg APT_ENABLE_SRV_RECORDS=false` 使用 apt 官方兼容设置；不关闭 TLS 或仓库签名校验。

根目录 `.dockerignore` 排除 `.git`、依赖、产物、环境密钥和数据库，同时保留后端 `include_str!` 需要的 Markdown。旧 `deploy/docker/.dockerignore` 仅留作历史参考，不是根构建上下文的规则。已修复 Rust 阶段缺少 addon-resource-dedupe 嵌入文件的问题。

默认构建/发布平台是 **linux/amd64**，未宣称 ARM64 支持。运行时包含版本固定的 Docker CLI 与 Compose 插件，不包含 Docker daemon。

## 本机安全启动

在本机环境中设置 `OMNIPANEL_API_KEY` 为长随机值（不要提交、发到聊天或放进 Vite 的 `VITE_*` 变量）。下面 `-e OMNIPANEL_API_KEY` 从环境传递，避免将密钥值写进命令参数：

```bash
# 先在本地环境设置 OMNIPANEL_API_KEY；例如由你自己的密钥管理器注入。
docker run -d --name omnipanel -p 127.0.0.1:8899:8899 \
  -v omnipanel-data:/data -e OMNIPANEL_API_KEY omnipanel-web:local
```

打开 <http://127.0.0.1:8899>，在 **服务器访问 / Server access** 页面输入该部署密钥，然后进入工作台。这与可选的 OmniPanel 云账号登录不同。

**未配置密钥时镜像默认拒绝启动**。仅隔离开发可显式设置 `OMNIPANEL_ALLOW_UNAUTHENTICATED=1`；不得用于公网或 Docker socket 管理。

### Compose

```bash
cd deploy/docker
cp .env.example .env
# 在本地编辑 .env 设置 OMNIPANEL_API_KEY
# 默认精确版本 ghcr.io/omniultrax/omnipanel-web:0.8.59，先确认 Docker 发布成功。
# 本地源码测试则在 .env 设置 OMNIPANEL_IMAGE=omnipanel-web:local 并先完成构建。
docker compose up -d
```

默认仅发布回环端口，不挂载 Docker socket，镜像固定为 Docker Web 0.8.59。**不要继续运行早于该修复版的旧镜像。** 必须确认发布工作流与匿名拉取通过；生产可把 `OMNIPANEL_IMAGE` 进一步固定到已校验的 digest。已发布的 `0.8.57`、`0.8.58` 固定标签不会被覆盖。本地源码构建仍可显式选择 `omnipanel-web:local`。

## 认证与反向代理

**升级提醒：旧版曾将部署密钥公开写入 runtime-config.js。使用过旧版的部署必须更换 API Key，并检查代理日志/缓存；仅替换镜像不能撤销已泄漏的旧密钥。** 本轮不会读取或修改你的真实部署密钥。

- 服务器密钥只存在服务端环境；不生成包含密钥的公开 HTML/JS/config，不支持 `VITE_OMNIPANEL_API_KEY`。
- 浏览器经同源 `POST /ipc/auth` 验证后获得随机、不透明的 **HttpOnly / SameSite=Strict** 会话 cookie，8 小时过期。密钥不进入 URL、localStorage、sessionStorage 或登录响应。登录响应 `Cache-Control: no-store`。
- HTTP IPC 和 WS 均要求有效会话或 CLI `Authorization: Bearer ...`。WS 不再接受 query token。退出/会话过期后已有 WS 最迟 30 秒断开；服务重启撤销全部浏览器会话，数据不会丢失。
- 右下角 **锁定 Web / Lock** 可退出。会话 cookie 有有效期；共享电脑使用后请锁定。
- 默认同源部署；不同 Origin 的 IPC、登录、注销和 WS 被拒绝，没有 wildcard CORS。命令行无 Origin 请求仍需密钥。反向代理必须保留原始 `Host`，不要记录认证请求体、Authorization、Cookie 或 Set-Cookie。当前不支持跨域前后端部署。
- 公网必须使用 **HTTPS**，设置 `OMNIPANEL_SECURE_COOKIE=1`；反代应额外限速登录。可叠加整个站点的访问控制。不要将明文 HTTP 登录端口直接暴露到公网。
- `/healthz` 可公开用于探针；`/ipc/auth` GET 只返回是否需要认证及当前会话状态，不返回密钥。

## 可选 Docker Engine 管理

Docker socket 相当于宿主机高权限，默认不挂载。确认风险后显式使用：

```bash
docker compose -f docker-compose.yml -f docker-compose.engine.yml up -d
# 可通过 OMNIPANEL_DOCKER_SOCKET 指定自己的隔离或 rootless Engine socket。
```

应用自身不需要 privileged。CLI、Compose、容器 API 操作会作用于所挂载 Engine；只连接可信 Engine。宿主 Compose 文件与绑定挂载路径**不会**因 socket 自动出现在容器内，需显式同路径挂载所需目录或通过 SSH 管理宿主。宿主 daemon 重启、系统服务控制不保证容器内可用。

终端、本地文件、SQLite 路径发生在容器内，不是访问浏览器那台电脑；数据目录包括 `/data/.omnipd`、`/data/omnipd/secrets` 与安装的插件目录 `/data/plugins`，必须完整挂载 `/data`。不支持桌面系统窗口/系统托盘、应用内更新和网络抓包。

运行时镜像按桌面默认随包提供第一方 ClickHouse / MongoDB / Redis 引擎 sidecar（与 `omnipanel-server` 同目录，Dockerfile 可重现构建）。MySQL / Postgres 默认仍走进程内驱动。云厂商、Nacos、官方 Agent、Warpgate 等是市场 **download-only** 插件，**不会**打进镜像；请在插件中心从官方目录安装，或安装已签名的 `.omni-plugin`。安装后出现在对应入口，并随 `/data` 持久化。不要把 download-only 插件改成镜像内置默认值。

无头容器没有桌面系统钥匙串；当前凭据 fallback 会把连接密钥保存为 `/data/omnipd/secrets/*.secret` 文件（权限 `0600`，不是额外的加密密钥库）。Docker/宿主管理员仍可读取数据卷和容器环境中的部署密钥；请保护并加密宿主磁盘/备份。共享部署密钥代表整个工作台的管理权限，当前不是多租户隔离边界。

## 环境变量

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `OMNIPANEL_IMAGE` | Compose 精确发布镜像；本地构建可覆盖 | `ghcr.io/omniultrax/omnipanel-web:0.8.59` |
| `OMNIPANEL_API_KEY` | 必填服务端部署密钥；不要编译进前端 | 无 |
| `OMNIPANEL_PORT` | 容器内部端口（基础 Compose 固定为 8899，外部端口用同名 .env 变量） | `8899` |
| `OMNIPANEL_BIND` | 容器内监听地址 | `0.0.0.0` |
| `OMNIPANEL_BIND_HOST` | Compose 宿主发布地址 | `127.0.0.1` |
| `OMNIPANEL_DATA_DIR` | HOME / 数据根；已安装插件默认在 `$OMNIPANEL_DATA_DIR/plugins` | `/data` |
| `OMNIPANEL_PLUGINS_DIR` | 覆盖插件安装目录 | `$OMNIPANEL_DATA_DIR/plugins` |
| `OMNIPANEL_SECURE_COOKIE` | HTTPS 反代部署设为 1 | `0` |
| `OMNIPANEL_ALLOW_UNAUTHENTICATED` | 仅隔离开发显式允许无密钥 | `0` |

Render / DigitalOcean 模板已要求生成/配置密钥；Railway / Fly.io / Zeabur / Koyeb 等部署必须在平台秘密变量中设置 `OMNIPANEL_API_KEY`。未配置时 fail closed 是预期行为，不要通过关闭鉴权绕过。

## 自动化验收与发布语义

`python3 scripts/smoke-docker-web.py IMAGE` 使用随机合成密钥、回环端口、唯一容器/数据卷，检查默认拒绝无密钥启动、静态资源不泄漏密钥、错误/缺失/撤销认证、Origin、WS、PTY、文件、SQLite、经应用 IPC 的真实 ClickHouse 查询、数据和模拟凭据重启/重建持久化，以及官方云插件的发现/加载、缺失凭据错误路径和卷持久化；不对真实云厂商 endpoint 发送测试密钥。静态检查包含 SPA fallback：`/dashboard`、`/module/files`、`/module/database` 返回与 `/` 相同的 `index.html`，缺失的 `/assets/*` 仍是 404，API/WS 不受影响。结束只清理自己的资源。设置 `OMNIPANEL_TEST_DOCKER_SOCKET` 后附加该 Engine 上自己测试容器的 start/stop、CLI、Compose up/logs/down 检查。请优先隔离 Engine；测试不连接真实 SSH/云账号。真实阿里云账户调用仍需另行授权，不在本冒烟范围内。

`Docker Web Image` 工作流先 build+load，再运行上述冒烟；通过后才允许推送**同一个已测镜像**。`workflow_dispatch` 默认 `publish=false`，只有明确选择发布并提供与 Cargo workspace 一致的 `image_version` 才推送。tag 触发也必须与源码版本一致。正式发布更新精确版本、主次版本别名（例如 `0.8`）和 `latest`，预发布只更新精确版本 tag。发布后匿名拉取、version/revision 标签校验也必须通过；包必须预先设为 public，工作流不会悄悄更改组织权限。

推送桌面标签 `v0.8.59` 会同时触发桌面发布与 Docker 工作流（版本必须与 Cargo workspace 一致）。跟踪标签 `docker-v0.8.59` 不匹配桌面 `v*` 触发器，用于 Docker 发行说明，且不会取代 GitHub 上的桌面 latest。只有全部测试通过的同一个镜像会更新 GHCR `0.8.59`、`0.8`、`latest`；已有 `0.8.57`、`0.8.58` 固定标签保持不变。后续匿名校验必须通过。
