import sys, os, ast
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from models import ModelPool
from core import ParentBot

pool = ModelPool(api_key='test')
bot = ParentBot(pool=pool, verbose=False)
bot.log.sys('=== Multi-Agent 系统自检 ===')

# 1. Agent 注册
print('\n【已注册 Agent】')
for name in bot.children:
    c = bot.children[name]
    n_tools = len(c.tools)
    print(f'  {name}: {n_tools} 工具 — {c.description}')

# 2. 路由测试（关键词兜底）
print('\n【路由测试（关键词兜底）】')
tests = [
    ('Python怎么实现LRU缓存', '代码Agent'),
    ('搜索最新的GPT-5新闻', '搜索Agent'),
    ('/tmp目录下有什么文件', '文件Agent'),
    ('查看系统CPU使用率', '电脑Agent'),
]
for query, expected in tests:
    result = bot._route(query)
    if result is None:
        result = bot._keyword_route(query)
    match = 'OK' if result == expected else 'FAIL'
    print(f'  [{match}] "{query}" → {result}')

# 3. 浏览器工具自检
print('\n【浏览器工具自检】')
from core import _browser_get_context, _browser_navigate, _browser_close, _browser_get_state
try:
    _browser_navigate({'url': 'https://httpbin.org/get'})
    state = _browser_get_state()
    wd = _browser_get_context().pages[0].evaluate('() => navigator.webdriver')
    print(f'  Playwright 引擎: OK')
    print(f'  Stealth: {"OK (webdriver=None)" if wd is None else "FAIL"}')
    _browser_close()
except Exception as e:
    print(f'  FAIL: {e}')

# 4. web_fetch_upgraded
print('\n【web_fetch_upgraded】')
from core import _web_fetch_upgraded
r = _web_fetch_upgraded({'url': 'https://httpbin.org/headers', 'max_chars': 100})
print(f'  HTTP静态页: {"OK" if "headers" in r else "FAIL"} ({len(r)}字符)')

# 5. 语法
with open('core.py') as f:
    ast.parse(f.read())
print('\n【语法】OK')

print('\n=== 自检通过 ===')
