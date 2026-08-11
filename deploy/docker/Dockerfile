# syntax=docker/dockerfile:1
# OmniPanel Web 运行时镜像（ghcr.io/omniultrax/omnipanel-web）
#
# 构建（仓库根目录）:
#   docker build -f deploy/docker/Dockerfile -t ghcr.io/omniultrax/omnipanel-web:local .

# ---------- 前端：Web 模式静态产物 ----------
FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ENV SKIP_GEN_BINDINGS=1
ENV OMNIPANEL_WEB=1
RUN npm run build

# ---------- 后端：仅编译 omnipanel-server（不含 Tauri） ----------
FROM rust:bookworm AS rust-builder
WORKDIR /build
RUN apt-get update \
  && apt-get install -y --no-install-recommends pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY src-tauri/Cargo.toml ./src-tauri/Cargo.toml
# workspace member 占位，避免拉取完整 Tauri 源码层
RUN mkdir -p src-tauri/src \
  && printf 'fn main() {}\n' > src-tauri/src/main.rs \
  && printf '#[allow(dead_code)] pub fn noop() {}\n' > src-tauri/src/lib.rs \
  && printf 'fn main() {}\n' > src-tauri/build.rs

ENV CARGO_INCREMENTAL=0
RUN cargo build --release -p omnipanel-server

# ---------- 运行时 ----------
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libssl3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=rust-builder /build/target/release/omnipanel-server /usr/local/bin/omnipanel-server
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
