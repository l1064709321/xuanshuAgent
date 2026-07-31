# ═══════════════════════════════════════════
#  玄姝 Agent — Docker 镜像
#  一键启动，无需手动装依赖
# ═══════════════════════════════════════════
FROM python:3.10-slim

# 避免交互式提示
ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# 1. 系统依赖（git 用于版本回滚功能）
RUN apt-get update && \
    apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*

# 2. Python 依赖（利用缓存层，requirements.txt 不变就不重装）
COPY requirements.txt .
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
    -r requirements.txt

# 3. 复制项目源码
COPY . .

# 4. 创建运行时目录
RUN mkdir -p .memdir .memory .sandbox workspace_files workflows .skills

# 5. 暴露端口
EXPOSE 8901

# 6. 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8901/health || exit 1

# 7. 启动
CMD ["python", "frontend.py"]
