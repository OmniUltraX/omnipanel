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

# =============================================================
# 预编译（核心）
#
# 仅预览模式下，平台在 Prepare 阶段对业务端口 8686 做启动检测（窗口约 226s）。
# 前端 build + cargo build --release 全量构建远超该窗口，无法在 launch 阶段内完成。
# 故把耗时的前后端构建前置到镜像构建阶段（docker.build 在 git-clone 之后执行，
# 仓库源码已在构建上下文），让 launch 只做秒级启动，从而在端口检测窗口内就绪。
# =============================================================
COPY . /workspace

# ---- 前端：Web 模式构建（生成 frontend/dist）----
RUN set -eux; \
    cd /workspace/frontend \
    && npm ci \
    && SKIP_GEN_BINDINGS=1 OMNIPANEL_WEB=1 npm run build

# ---- 后端：构建 omnipanel-server（release）----
RUN set -eux; \
    cd /workspace \
    && cargo build --release -p omnipanel-server
