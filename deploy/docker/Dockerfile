# syntax=docker/dockerfile:1
# OmniPanel Web 运行时镜像（ghcr.io/omniultrax/omnipanel-web）
#
# 构建（仓库根目录）:
#   docker build -f deploy/docker/Dockerfile -t ghcr.io/omniultrax/omnipanel-web:local .

# ---------- 前端：Web 模式静态产物 ----------
FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
# file:../packages/* 必须在 npm ci 之前就位，否则 lock 里的 workspace 链是空的
COPY packages /build/packages
RUN npm ci
COPY frontend/ ./
# vite alias @repo-logo → ../logo；tsc 还要解析 plugin-sdk / plugin-ui 与插件清单
COPY logo /build/logo
COPY plugins /build/plugins
ENV SKIP_GEN_BINDINGS=1
ENV OMNIPANEL_WEB=1
RUN npm run build

# ---------- 后端：仅编译 omnipanel-server（不含 Tauri） ----------
FROM rust:bookworm AS rust-builder
WORKDIR /build
# Optional documented apt setting for environments whose DNS proxy cannot resolve SRV targets.
ARG APT_ENABLE_SRV_RECORDS=true
RUN apt-get -o Acquire::EnableSrvRecords=$APT_ENABLE_SRV_RECORDS update \
  && apt-get -o Acquire::EnableSrvRecords=$APT_ENABLE_SRV_RECORDS install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    libdbus-1-dev \
    libudev-dev \
  && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# workspace 成员 sidecar，以及编译期 include_str! 的第一方清单。
# 云厂商 / Warpgate / Nacos / 官方 Agent 是 download-only，不打进运行时镜像。
# 官方目录种子（registry.json）供 Web 插件中心回退，不含插件逻辑包。
COPY plugins/agent-cursor/src-agent ./plugins/agent-cursor/src-agent
COPY plugins/agent-cursor/plugin.json ./plugins/agent-cursor/plugin.json
COPY plugins/agent-opencode-go/src-agent ./plugins/agent-opencode-go/src-agent
COPY plugins/agent-opencode-go/plugin.json ./plugins/agent-opencode-go/plugin.json
COPY plugins/agent-trae/src-agent ./plugins/agent-trae/src-agent
COPY plugins/agent-trae/plugin.json ./plugins/agent-trae/plugin.json
COPY plugins/agent-trae-global/plugin.json ./plugins/agent-trae-global/plugin.json
COPY plugins/agent-workbuddy/src-agent ./plugins/agent-workbuddy/src-agent
COPY plugins/agent-workbuddy/plugin.json ./plugins/agent-workbuddy/plugin.json
COPY plugins/theme-default/plugin.json plugins/theme-default/tokens.json ./plugins/theme-default/
COPY plugins/addon-everything/plugin.json ./plugins/addon-everything/plugin.json
# resource-dedupe embeds its manifest, logic, icon and UI through include_str!.
COPY plugins/addon-resource-dedupe ./plugins/addon-resource-dedupe
COPY plugins/panel-1panel/plugin.json ./plugins/panel-1panel/plugin.json
COPY plugins/panel-bt/plugin.json ./plugins/panel-bt/plugin.json
COPY plugins/panel-hestia/plugin.json plugins/panel-hestia/logic.js ./plugins/panel-hestia/
COPY plugins/db-qdrant/plugin.json ./plugins/db-qdrant/plugin.json
COPY plugins/db-clickhouse/plugin.json ./plugins/db-clickhouse/plugin.json
COPY plugins/db-mongodb/plugin.json ./plugins/db-mongodb/plugin.json
COPY plugins/db-mysql/plugin.json ./plugins/db-mysql/plugin.json
COPY plugins/db-postgres/plugin.json ./plugins/db-postgres/plugin.json
COPY plugins/db-redis/plugin.json ./plugins/db-redis/plugin.json
COPY plugins/db-sqlite/plugin.json ./plugins/db-sqlite/plugin.json
COPY plugins/db-sqlserver/plugin.json ./plugins/db-sqlserver/plugin.json
COPY plugins/importer-docker-db/plugin.json plugins/importer-docker-db/icon.svg ./plugins/importer-docker-db/
COPY plugins/registry.json ./plugins/registry.json
COPY src-tauri/Cargo.toml ./src-tauri/Cargo.toml
# workspace member 占位，避免拉取完整 Tauri 源码层
RUN mkdir -p src-tauri/src \
  && printf 'fn main() {}\n' > src-tauri/src/main.rs \
  && printf '#[allow(dead_code)] pub fn noop() {}\n' > src-tauri/src/lib.rs \
  && printf 'fn main() {}\n' > src-tauri/build.rs

ENV CARGO_INCREMENTAL=0
ARG CARGO_BUILD_JOBS=4
ENV CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS
# Keep registry/dependency caches; refresh workspace source mtimes so cache mounts cannot serve a stale binary.
# BuildKit COPY ignores mtimes, while Cargo freshness uses them. Copy the binary out of the cache mount.
RUN --mount=type=cache,id=omnipanel-web-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=omnipanel-web-target,target=/build/target \
    bash -c 'shopt -s globstar nullglob; touch crates/**/*.rs' \
    && cargo build --locked --release -p omnipanel-server \
        -p omnipanel-engine-clickhouse \
        -p omnipanel-engine-mongodb \
        -p omnipanel-engine-redis \
    && cp /build/target/release/omnipanel-server /build/omnipanel-server \
    && cp /build/target/release/omnipanel-engine-clickhouse /build/omnipanel-engine-clickhouse \
    && cp /build/target/release/omnipanel-engine-mongodb /build/omnipanel-engine-mongodb \
    && cp /build/target/release/omnipanel-engine-redis /build/omnipanel-engine-redis

# Explicit test target; not part of the runtime image.
FROM rust-builder AS rust-tests
RUN --mount=type=cache,id=omnipanel-web-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=omnipanel-web-target,target=/build/target \
    bash -c 'shopt -s globstar nullglob; touch crates/**/*.rs' \
    && cargo test --locked --release -p omnipanel-server --lib -- --test-threads=1

# CLI and Compose binaries are static; no daemon/privileged container required.
FROM docker:28.5.2-cli AS docker-cli

# ---------- 运行时 ----------
FROM debian:bookworm-slim AS runtime
# Optional documented apt setting for environments whose DNS proxy cannot resolve SRV targets.
ARG APT_ENABLE_SRV_RECORDS=true
RUN apt-get -o Acquire::EnableSrvRecords=$APT_ENABLE_SRV_RECORDS update \
  && apt-get -o Acquire::EnableSrvRecords=$APT_ENABLE_SRV_RECORDS install -y --no-install-recommends \
    ca-certificates \
    curl \
    libssl3 \
    libdbus-1-3 \
    libudev1 \
    bash \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
RUN docker --version && docker compose version

ARG OMNIPANEL_VERSION=local
ARG OMNIPANEL_REVISION=uncommitted
LABEL org.opencontainers.image.version=$OMNIPANEL_VERSION \
      org.opencontainers.image.revision=$OMNIPANEL_REVISION

WORKDIR /app

COPY --from=rust-builder /build/omnipanel-server /usr/local/bin/omnipanel-server
# Same default first-party engine sidecars as the desktop packages; resolved next to the server.
COPY --from=rust-builder /build/omnipanel-engine-clickhouse /usr/local/bin/omnipanel-engine-clickhouse
COPY --from=rust-builder /build/omnipanel-engine-mongodb /usr/local/bin/omnipanel-engine-mongodb
COPY --from=rust-builder /build/omnipanel-engine-redis /usr/local/bin/omnipanel-engine-redis
COPY --from=frontend /build/frontend/dist /app/static
COPY deploy/docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV HOME=/data \
    OMNIPANEL_DATA_DIR=/data \
    OMNIPANEL_PORT=8899 \
    OMNIPANEL_BIND=0.0.0.0 \
    OMNIPANEL_STATIC_DIR=/app/static

VOLUME ["/data"]
EXPOSE 8899

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${OMNIPANEL_PORT}/healthz" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
