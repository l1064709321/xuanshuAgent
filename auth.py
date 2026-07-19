"""玄姝 — 手机号注册/登录模块（SQLite + 阿里云短信 + JWT）"""
import os, sqlite3, hashlib, time, random, hmac, json, base64, threading
from datetime import datetime, timedelta

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, ".xuanshu_users.db")

# ── 阿里云短信配置 ──
ALIBABA_ACCESS_KEY = os.environ.get("ALIBABA_ACCESS_KEY", "")
ALIBABA_ACCESS_SECRET = os.environ.get("ALIBABA_ACCESS_SECRET", "")
SMS_SIGN_NAME = os.environ.get("SMS_SIGN_NAME", "玄姝Agent")
SMS_TEMPLATE_CODE = os.environ.get("SMS_TEMPLATE_CODE", "SMS_123456789")

# ── JWT 密钥 ──
_JWT_SECRET = os.environ.get("JWT_SECRET", base64.b64encode(os.urandom(32)).decode()[:32])

_lock = threading.Lock()

def _conn():
    c = sqlite3.connect(DB_PATH)
    c.execute("PRAGMA journal_mode=WAL")
    return c

def init_db():
    with _lock, _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_login TEXT
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS sms_codes (
                phone TEXT NOT NULL,
                code TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                used INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        c.commit()

init_db()

# ── 密码 ──
def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 200000)
    return base64.b64encode(salt + dk).decode()

def verify_password(pw: str, hashed: str) -> bool:
    raw = base64.b64decode(hashed.encode())
    salt, dk = raw[:16], raw[16:]
    new_dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 200000)
    return hmac.compare_digest(dk, new_dk)

# ── 验证码 ──
def generate_code() -> str:
    return f"{random.randint(0, 999999):06d}"

def send_sms(phone: str, code: str) -> dict:
    """发送短信验证码 — 阿里云 SMS"""
    if not ALIBABA_ACCESS_KEY or not ALIBABA_ACCESS_SECRET:
        # 无配置时模拟发送，打印到控制台
        print(f"\n[SMS 模拟] 发送验证码 {code} 到 {phone}\n")
        return {"ok": True, "mock": True}

    try:
        from alibabacloud_dysmsapi20170525.client import Client as DysmsClient
        from alibabacloud_dysmsapi20170525 import models as dysms_models
        from alibabacloud_tea_openapi import models as openapi_models

        cfg = openapi_models.Config(
            access_key_id=ALIBABA_ACCESS_KEY,
            access_key_secret=ALIBABA_ACCESS_SECRET,
        )
        cfg.endpoint = "dysmsapi.aliyuncs.com"
        client = DysmsClient(cfg)

        req = dysms_models.SendSmsRequest(
            phone_numbers=phone,
            sign_name=SMS_SIGN_NAME,
            template_code=SMS_TEMPLATE_CODE,
            template_param=json.dumps({"code": code}),
        )
        resp = client.send_sms(req)
        if resp.body.code == "OK":
            return {"ok": True}
        return {"ok": False, "error": f"短信发送失败: {resp.body.message}"}
    except Exception as e:
        print(f"\n[SMS 模拟-发送失败] 验证码 {code} 到 {phone} ({e})\n")
        return {"ok": True, "mock": True, "fallback": str(e)}

def store_code(phone: str, code: str):
    expires = (datetime.utcnow() + timedelta(minutes=5)).strftime("%Y-%m-%d %H:%M:%S")
    with _lock, _conn() as c:
        c.execute("INSERT INTO sms_codes (phone, code, expires_at) VALUES (?, ?, ?)",
                  (phone, code, expires))
        c.commit()

def verify_code(phone: str, code: str) -> bool:
    with _lock, _conn() as c:
        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        row = c.execute(
            "SELECT id FROM sms_codes WHERE phone=? AND code=? AND expires_at > ? AND used=0 ORDER BY id DESC LIMIT 1",
            (phone, code, now)
        ).fetchone()
        if row:
            c.execute("UPDATE sms_codes SET used=1 WHERE id=?", (row[0],))
            c.commit()
            return True
    return False

# ── 用户操作 ──
def user_register(phone: str, password: str, sms_code: str) -> dict:
    """注册：验证短信 → 检查是否已注册 → 创建用户"""
    if not verify_code(phone, sms_code):
        return {"ok": False, "error": "验证码错误或已过期"}

    pw_hash = hash_password(password)
    try:
        with _lock, _conn() as c:
            c.execute("INSERT INTO users (phone, password_hash) VALUES (?, ?)",
                      (phone, pw_hash))
            user_id = c.lastrowid
            c.commit()
        token = _make_token(user_id, phone)
        return {"ok": True, "user_id": user_id, "phone": phone, "token": token}
    except sqlite3.IntegrityError:
        return {"ok": False, "error": "该手机号已注册"}
    except Exception as e:
        return {"ok": False, "error": f"注册失败: {e}"}

def user_login(phone: str, password: str) -> dict:
    """登录：手机号 + 密码"""
    with _conn() as c:
        row = c.execute(
            "SELECT id, phone, password_hash FROM users WHERE phone=?", (phone,)
        ).fetchone()
    if not row:
        return {"ok": False, "error": "手机号未注册"}
    user_id, ph, pw_hash = row
    if not verify_password(password, pw_hash):
        return {"ok": False, "error": "密码错误"}

    with _lock, _conn() as c:
        c.execute("UPDATE users SET last_login=datetime('now') WHERE id=?", (user_id,))
        c.commit()

    token = _make_token(user_id, ph)
    return {"ok": True, "user_id": user_id, "phone": ph, "token": token}

# ── JWT ──
def _make_token(user_id: int, phone: str) -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).rstrip(b"=").decode()
    payload = {
        "uid": user_id,
        "phone": phone,
        "iat": int(time.time()),
        "exp": int(time.time()) + 7 * 24 * 3600,
    }
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    sig = hmac.new(_JWT_SECRET.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode()
    return f"{header}.{body}.{sig_b64}"

def verify_token(token: str) -> dict | None:
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        header, body, sig = parts
        expected_sig = base64.urlsafe_b64encode(
            hmac.new(_JWT_SECRET.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()
        ).rstrip(b"=").decode()
        if not hmac.compare_digest(sig, expected_sig):
            return None
        # 补齐 base64 padding
        body_padded = body + "=" * (4 - len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(body_padded))
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None

def get_user_from_request() -> dict | None:
    """从 Flask request header 解析当前用户"""
    from flask import request
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    return verify_token(auth[7:])

# ── 频率限制 ──
_sms_cooldown: dict[str, float] = {}

def check_sms_rate(phone: str) -> int:
    """返回还需等待的秒数，0 表示可发送"""
    now = time.time()
    last = _sms_cooldown.get(phone, 0)
    elapsed = now - last
    if elapsed < 60:
        return int(60 - elapsed)
    return 0
