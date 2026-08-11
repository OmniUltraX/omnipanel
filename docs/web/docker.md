# OmniPanel Web — Docker 部署

镜像：`ghcr.io/omniultrax/omnipanel-web`

浏览器访问同一套 OmniPanel 前端，后端为 `omnipanel-server`（HTTP `/ipc/invoke` + WebSocket `/ipc/events`）。数据持久化在容器内 `HOME`（默认 `/data/.omnipd`）。

## 一键启动

### docker run

```bash
docker run -d --name omnipanel \
  -p 8899:8899 \
  -v omnipanel-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e OMNIPANEL_API_KEY=请替换为长随机字符串 \
  ghcr.io/omniultrax/omnipanel-web:latest
```

浏览器打开：<http://localhost:8899>

### docker compose

```bash
cd deploy/docker
cp .env.example .env   # 编辑 OMNIPANEL_API_KEY
docker compose up -d
```

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `OMNIPANEL_API_KEY` | IPC 鉴权密钥；**未设置时容器仍可启动，但会打印安全警告** | 空 |
| `OMNIPANEL_PORT` | 监听端口 | `8899` |
| `OMNIPANEL_BIND` | 绑定地址 | `0.0.0.0` |
| `OMNIPANEL_DATA_DIR` | 数据根（`HOME`） | `/data` |

设置 `OMNIPANEL_API_KEY` 后，entrypoint 会生成 `/omnipanel-runtime-config.js`，浏览器自动携带 `Authorization: Bearer <key>`。

## 挂载宿主机 Docker

Compose 默认挂载 `/var/run/docker.sock`，可在 Web UI 中管理**宿主机** Docker Engine。

> **安全提示**：等同于授予容器内访客操作宿主机 Docker 的能力。务必设置强 `OMNIPANEL_API_KEY`，并仅在内网 / 反代后使用。不需要管理宿主机 Docker 时，删除 compose 中的 `docker.sock` 卷即可。

## 从源码构建镜像

```bash
docker build -f deploy/docker/Dockerfile -t ghcr.io/omniultrax/omnipanel-web:local .
```

## 与桌面版差异

- 不支持：网络抓包（sniffer）、应用内更新
- 操作发生在**容器所在环境**（终端、SSH、本地文件等）

## 健康检查

```bash
curl -fsS http://127.0.0.1:8899/healthz
```
