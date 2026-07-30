# 玄姝 Agent — Docker 镜像（amd64 + arm64 通用）
FROM python:3.10-slim

WORKDIR /app

# 预编译依赖（避免 ARM 上 backports.zoneinfo 踩坑）
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
    flask \
    requests \
    alibabacloud_dysmsapi20170525

# numpy/scikit-learn/wikipedia 可选，需要时可取消注释
# RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
#     numpy scikit-learn wikipedia

COPY . /app

EXPOSE 8901

CMD ["python", "frontend.py"]
