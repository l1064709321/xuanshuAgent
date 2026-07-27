"""结构化日志 — 精简版"""
import time, uuid

_trace_id = None

def set_trace_id():
    global _trace_id
    _trace_id = uuid.uuid4().hex[:12]

def request_start(method, path, **kwargs):
    pass

def request_end(status, elapsed, **kwargs):
    pass

def warn(event, **kwargs):
    print(f"[WARN] {event} {' '.join(f'{k}={v}' for k,v in kwargs.items())}")

def info(event, **kwargs):
    print(f"[INFO] {event} {' '.join(f'{k}={v}' for k,v in kwargs.items())}")
