"""玄姝配置 — 精简版"""
import os
from types import SimpleNamespace

config = SimpleNamespace(
    HOST=os.environ.get("XS_HOST", "0.0.0.0"),
    PORT=int(os.environ.get("XS_PORT", "8901")),
    DEBUG=os.environ.get("XS_DEBUG", "False").lower() == "true",
    RL_CHAT_PER_MIN=30,
    RL_CHAT_BURST=10,
    SMTP_HOST=os.environ.get("SMTP_HOST", ""),
    SMTP_PORT=int(os.environ.get("SMTP_PORT", "587")),
    SMTP_USER=os.environ.get("SMTP_USER", ""),
    SMTP_PASS=os.environ.get("SMTP_PASS", ""),
)
