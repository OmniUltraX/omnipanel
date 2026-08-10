# OmniPanel 云原生开发镜像
#
# 基于 CNB 默认开发镜像（预装 code-server / cnb-welcome 插件），
# 在此之上补齐本项目需要的构建链：Rust 工具链 + Node.js 20。
# 用于 .cnb.yml 中 docker.build: .ide/Dockerfile 构建开发环境。

FROM cnbcool/default-dev-env:latest

# ---- Node.js 20（Rust 项目前端要求 Node 20+）----
# 默认镜像不一定带 Node，按需安装。
RUN set -eux; \
    if command -v node >/dev/null 2>&1; then \
      echo "node already present: $(node -v)"; \
    else \
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
        && apt-get install -y nodejs; \
    fi

# ---- Rust 工具链（1.85+）----
RUN set -eux; \
    if command -v cargo >/dev/null 2>&1; then \
      echo "cargo already present: $(cargo --version)"; \
    else \
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal; \
    fi
ENV PATH="/root/.cargo/bin:${PATH}" \
    CARGO_HOME="/root/.cargo"

# 常用开发工具
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl wget unzip openssh-client build-essential pkg-config \
      libssl-dev cmake libdbus-1-dev \
    && rm -rf /var/lib/apt/lists/*

# 支持中文命令行
ENV LANG C.UTF-8
ENV LANGUAGE C.UTF-8

# 工作目录
WORKDIR /workspace
