# ═══════════════════════════════════════════
#  玄姝 Agent — Docker 镜像
#  运行时基线：Node 20（服务本体）+ Python 3 / ffmpeg（子进程工具链）
#  一键启动: docker compose up -d --build
# ═══════════════════════════════════════════
FROM node:20-bookworm-slim

# 避免交互式提示
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    XS_HOST=0.0.0.0 \
    XS_PORT=8901

WORKDIR /app

# 1. 系统依赖：python3/pip（沙箱/PDF/TTS/数据工具子进程）、ffmpeg（音频）、curl（健康检查）、git（版本回滚）
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-pip ffmpeg curl git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# 2. Node 依赖（package*.json 不变则复用缓存层；含 devDeps 供 tsc 构建）
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

# 3. Python 依赖（子进程工具链）
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages \
        -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

# 4. 复制源码并构建 TS（dist/ 不入库，镜像内构建）
COPY . .
RUN npm run build

# 5. 浏览器内核（浏览器类工具需要，约 150MB；构建时 INSTALL_BROWSER=0 可跳过）
ARG INSTALL_BROWSER=1
RUN if [ "$INSTALL_BROWSER" = "1" ]; then \
        npx playwright install --with-deps chromium; \
    fi

# 6. 创建运行时目录（.data 存放模型 Key，注意在 compose 中挂载持久化）
RUN mkdir -p .memdir .memory .data .sandbox workspace_files workflows .skills

# 7. 暴露端口
EXPOSE 8901

# 8. 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:8901/health || exit 1

# 9. 启动
CMD ["node", "dist/server.js"]
