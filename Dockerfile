# 玄姝 Agent — Docker 镜像（amd64 + arm64 通用）
FROM python:3.10-slim

WORKDIR /app

# 全量依赖（Docker 环境无需降级）
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
    flask \
    requests \
    alibabacloud_dysmsapi20170525 \
    numpy \
    scikit-learn \
    wikipedia

COPY . /app

EXPOSE 8901

CMD ["python", "frontend.py"]
