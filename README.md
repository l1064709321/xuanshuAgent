# 玄姝 (Xuanshu) — 多 Agent 协作系统

[![Python](https://img.shields.io/badge/Python-3.8+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Flask-3.x-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
[![SSE](https://img.shields.io/badge/协议-SSE-FF6B35)](#)
[![REST](https://img.shields.io/badge/协议-REST-009688)](#)
[![SQLite](https://img.shields.io/badge/存储-SQLite-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

> 父 Bot 意图路由 → 子 Agent 工具调用 → 思考链流式输出 → Skill 自学习

---

## 快速开始

### 克隆仓库

**Gitee（国内推荐）：**

Linux / macOS / WSL：
```bash
git clone https://gitee.com/l1064709321/xuanshuAgent.git
cd xuanshuAgent
```

Windows（PowerShell）：
```powershell
git clone https://gitee.com/l1064709321/xuanshuAgent.git
cd xuanshuAgent
```

**GitHub：**

Linux / macOS / WSL：
```bash
git clone https://github.com/l1064709321/xuanshuAgent.git
cd xuanshuAgent
```

Windows（PowerShell）：
```powershell
git clone https://github.com/l1064709321/xuanshuAgent.git
cd xuanshuAgent
```

### 启动

| 方式 | 系统 | 命令 |
|------|------|------|
| 一键启动 | Linux / macOS / WSL | `bash xuanshu` |
| 一键启动 | Windows | `.\xuanshu.bat` |
| 手动启动 | Linux / macOS / WSL | `source .venv/bin/activate && python frontend.py` |
| 手动启动 | Windows | `.venv\Scripts\activate && python frontend.py` |

访问 http://localhost:8901。一键脚本自动完成：检测 Python ≥ 3.8 → 创建 `.venv` → 安装依赖 → 启动服务。

命令行模式将 `frontend.py` 换成 `main.py`。

#### systemd 服务（仅 Linux）

```bash
sudo cp xuanshu.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xuanshu
```

### 环境要求

- Python 3.8+
- Linux / macOS / Windows / WSL

---

## 系统概述

玄姝是一个运行在本地的多 Agent 协作系统。一个请求进来之后，不是单一大模型直接回答——而是由**父 Bot** 分析意图，路由到最合适的**子 Agent**（搜索/代码/文件/电脑/应用），子 Agent 自主调用工具完成任务，整个过程通过 SSE 实时推送到前端展示。

核心思路：不让一个模型干所有事，而是让「路由者」+「执行者」各司其职，复杂任务走协调者四阶段流水线。

### 工作流程

```
用户输入 "帮我写一个快排，测试后保存到 test.py"
        │
        ▼
┌──────────────────┐
│   父 Bot (Router) │  分析意图 → "代码Agent"
│  意图路由 + 协调者 │  命中复杂信号 → 启动协调者模式
└──────┬───────────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│              协调者模式 (四阶段)                │
│                                              │
│  Research ──→ 代码Agent 只读探索：环境、库版本  │
│     ↓                                        │
│  Synthesis ─→ 协调者 LLM 生成实施规格 (spec)    │
│     ↓                                        │
│  Implementation ─→ 代码Agent 按 spec 编码+测试  │
│     ↓                                        │
│  Verification ─→ 验证 LLM 对比原始需求校验      │
└──────────────────────────────────────────────┘
       │
       ▼
┌──────────────────┐
│  思考链 SSE 流式   │  每轮工具调用实时推送到前端
│  折叠面板逐轮展示  │  用户可见完整思考过程
└──────────────────┘
```

**简单任务**（"今天天气怎么样"）：父 Bot 直接路由到搜索Agent，单 Agent 单轮执行。

**复杂任务**（"把项目里所有 TODO 注释提取出来写到文件"）：触发协调者模式，先研究文件结构 → 生成 spec → 按 spec 执行 → 验证结果。

---

## 核心架构

### 父 Bot

入口只有一个：`ParentBot.process_input()`。

1. **意图路由**：用 `ROUTER_PROMPT` 让 LLM 判断该交给哪个子 Agent
2. **Continue / Fresh 判定**：检查当前活跃的 Agent 上下文，同 Agent + 相关主题则复用（Continue），否则新开（Fresh）
3. **协调者模式调度**：检测到复杂任务时自动走四阶段流水线

### 子 Agent

6 个子 Agent，每个都有独立的记忆、工具集、人格宪法：

| Agent | 职责 | 工具 |
|-------|------|------|
| 搜索 | 联网搜索、百科、天气、网页抓取 | web_search, web_fetch, weather |
| 浏览器 | 浏览器交互、页面抓取 | navigate, extract, click, type, scroll, screenshot |
| 代码 | 编程、调试、shell 执行、沙箱 | shell_run, sandbox_run, git_log, git_revert |
| 文件 | 文件读写、反编译、项目结构分析 | read_file, write_file, list_dir, decompile, grep |
| 电脑 | 系统信息、进程管理、资源监控 | sys_info, disk_usage, memory_usage, cpu_info |
| 应用 | 软件包管理（dnf/yum） | pkg_search, pkg_install, pkg_remove, pkg_update |

所有 Agent 共享：`memdir_*`（共享记忆读写）和 `git_*`（版本回滚）。

每个子 Agent 启动时注入人格宪法，定义核心价值观、表达风格、行为边界和工具使用方式。

### 工具调用

```
LLM 输出 tool_call
    │
    ▼
_dispatch_tool_call()
    ├── 1. 解析 function.name + function.arguments (JSON 容错)
    ├── 2. 模糊匹配工具名 (精确→子串→编辑距离)
    ├── 3. 参数校验 + 默认值填充
    └── 4. ToolExecutor.execute()
            ├── 重试 (最多 2 次)
            └── 降级 (web_search → web_fetch)
```

### Skill 自学习

- **触发**：任意 Agent 完成 ≥ 4 轮工具调用的任务
- **提炼**：LLM 从任务经验中提取 Markdown 格式 Skill 文档
- **存储**：写入子 Agent 专有目录 `.memdir/skills/*.md`
- **检索**：jieba 分词 + TF-IDF 向量 + 余弦相似度匹配历史 Skill
- **持久化**：SQLite 存向量索引

### 记忆系统

| 层级 | 存储 | 说明 |
|------|------|------|
| 短期 | Agent 对话历史 (JSON) | 当前会话上下文 |
| 中期 | 子 Agent 独立记忆 | `.memory/{agent}.json` |
| 长期 | MEMORY.md + USER.md | Agent 自身经验 + 用户画像 |

共享记忆文件夹支持跨 Agent 的任意格式文件读写和快照导出。

---

## 模型配置

在 Web 界面设置页填入 API Key 并选择模型。也可设为 `local`（本地模拟模式，免 Key）。

### 直连官方 API

| 厂商 | 模型 |
|------|------|
| OpenAI | gpt-5.5 / gpt-5.5-pro / gpt-4o / gpt-4o-mini |
| Anthropic | claude-opus-4.8 / claude-sonnet-4.6 / claude-haiku-4.5 / claude-fable-5 |
| Google | gemini-3.1-pro / gemini-3-flash |
| DeepSeek | deepseek-v4-pro / deepseek-v4-flash / deepseek-v3 / deepseek-r1 |
| 阿里通义 | qwen3.7-max / qwen3.7-plus / qwen2.5-72b / qwen2.5-32b |
| 智谱 GLM | glm-5.2 / glm-4.7 / glm-4.7-flash / glm-4-air |
| 月之暗面 | kimi-k3 / kimi-k2.7-code / kimi-k2.7-code-highspeed / kimi-k2.6 |
| 字节豆包 | doubao-pro / doubao-lite |
| 百川 | baichuan4 |
| MiniMax | minimax-m3 / minimax-m2.7 / minimax-m2.7-fast / abab6.5 |
| 零一万物 | yi-large |
| 讯飞星火 | spark-4.0 |
| 腾讯混元 | hunyuan-pro |
| Mistral | mistral-large / mistral-small |
| Meta | llama-4 / llama-3.3 |
| xAI | grok-3 |
| Cohere | command-r-plus |
| NVIDIA | nemotron-super |
| AI21 | jamba-1.6 |
| Reka | reka-flash |

### 聚合平台

- **SiliconFlow** — 40+ 国产模型（Qwen/GLM/DeepSeek/Kimi/MiniMax）
- **OpenRouter** — 30+ 海外模型（DeepSeek/Gemini/Claude/Llama/Nemotron）
- **NVIDIA NIM** / **Groq** / **Together AI** — 高性能推理

### 本地推理

- **Ollama** / **LM Studio** / **vLLM** — 接入本地部署模型，数据不出机

---

## 运维

### Git 安装（无 sudo 环境）

受限服务器无 sudo 权限时用 rpm2cpio 装 git：

```bash
mkdir -p ~/git_rpm && cd ~/git_rpm
curl -O https://mirrors.tencent.com/tencentos/4/AppStream/x86_64/os/Packages/git-2.43.7-3.tl4.x86_64.rpm \
     -O https://mirrors.tencent.com/tencentos/4/AppStream/x86_64/os/Packages/git-core-2.43.7-3.tl4.x86_64.rpm \
     -O https://mirrors.tencent.com/tencentos/4/AppStream/x86_64/os/Packages/perl-Git-2.43.7-3.tl4.noarch.rpm

mkdir -p ~/local/bin ~/local/libexec/git-core
for f in *.rpm; do rpm2cpio "$f" | cpio -idmv 2>/dev/null; done
mv usr/bin/* ~/local/bin/ 2>/dev/null
mv usr/libexec/git-core/* ~/local/libexec/git-core/ 2>/dev/null
rm -rf usr *.rpm

export PATH="$HOME/local/bin:$PATH"
export GIT_EXEC_PATH="$HOME/local/libexec/git-core"
git --version
```

### 常见问题

#### Git Clone TLS 错误（Aidlux / ARM）

```bash
# 方案 A：优先使用 Gitee 镜像
git clone https://gitee.com/lord-of-the-star/xuan-shu-agent.git

# 方案 B：禁用 SSL 验证
GIT_SSL_NO_VERIFY=1 git clone --depth 1 https://github.com/l1064709321/xuanshuAgent.git

# 方案 C：wget 下载 zip
wget --no-check-certificate https://github.com/l1064709321/xuanshuAgent/archive/refs/heads/main.zip
unzip main.zip && mv xuanshuAgent-main xuanshuAgent
```

#### pip install 权限错误

```bash
# 方案 A：修复权限后全量安装
rm -rf .venv/lib/python3.*/site-packages/wikipedia*
chmod -R u+w .venv
source .venv/bin/activate
pip install --upgrade pip setuptools wheel
pip install -r requirements.txt

# 方案 B：跳过非必需包快速启动（wikipedia 非核心依赖）
rm -rf .venv && python3 -m venv .venv && source .venv/bin/activate
pip install --upgrade pip setuptools wheel
pip install flask requests httpx beautifulsoup4 lxml python-dotenv markdown
```

---

## API 端点

### 对话

| 端点 | 方法 | 说明 |
|------|------|------|
| `/chat` | POST | 同步对话 |
| `/chat/stream` | POST | SSE 流式对话 |

### 模型 & Key

| 端点 | 方法 | 说明 |
|------|------|------|
| `/models` | GET/POST | 列出/添加模型 |
| `/models/<key>` | DELETE | 删除模型 |
| `/set-key` | POST | 设置 API Key |
| `/model-key` | POST | 为模型设置 Key |
| `/model-key/status` | GET | Key + 模型状态 |
| `/switch-model` | POST | 切换当前模型 |

### 记忆 & 上下文

| 端点 | 方法 | 说明 |
|------|------|------|
| `/memory/list` | GET | 列出记忆 |
| `/memory/read` | POST | 读取记忆 |
| `/memory/write` | POST | 写入记忆 |
| `/memory/delete` | POST | 删除记忆 |
| `/context` | GET | 获取上下文 |
| `/context/save` | POST | 保存上下文 |
| `/snapshots/export` | POST | 导出快照 |
| `/snapshots/import` | POST | 导入快照 |

### 文件

| 端点 | 方法 | 说明 |
|------|------|------|
| `/browse` | POST | 浏览文件夹 |
| `/file/read` | POST | 读取文件 |

### 系统 & 工具

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/check_env` | GET | 检查环境 |
| `/api/presets` | GET | 预设操作 |
| `/api/run` | POST | 执行命令 |
| `/agents` | GET | 列出 Agent |
| `/metrics` | GET | 性能指标 |
| `/coordinator-mode` | POST | 切换协调者模式 |

### Skill

| 端点 | 方法 | 说明 |
|------|------|------|
| `/skills/list` | POST | 列出 Skill |
| `/skills/read` | POST | 读取 Skill |
| `/skills/create` | POST | 创建 Skill |
| `/skills/delete` | POST | 删除 Skill |

### Git

| 端点 | 方法 | 说明 |
|------|------|------|
| `/git-log` | GET | 提交记录 |
| `/git-status` | GET/POST | 工作区状态 |
| `/git-revert` | POST | 版本回退 |
| `/git-revert-restore` | POST | 撤销回退 |

---

## 项目结构

```
xuanshuAgent/
├── core.py              父 Bot + 协调者 + 子 Agent + Skill 系统
├── frontend.py           Flask 后端 + REST API + SSE
├── models.py             134+ 模型预设
├── memory.py             子 Agent 独立记忆 + 上下文持久化
├── web_search.py         联网搜索
├── monitor.py            性能监控
├── logger.py             日志模块
├── light_server.py       轻量 HTTP Server
├── sandbox.py            沙箱执行环境
├── auto_sandbox.py       自动沙箱检测
├── screen_reader.py      屏幕截图读取
├── main.py               命令行入口
├── index.html            Web 前端
├── style.css             样式
├── xuanshu               一键启动 (Linux/macOS)
├── xuanshu.bat           一键启动 (Windows)
├── xuanshu.service       systemd 服务
├── requirements.txt      依赖清单
├── .memdir/              共享记忆文件夹
│   └── snapshots/        记忆快照
├── .memory/              子 Agent 记忆
├── .skills/              手动 Skill
└── decompile/            反编译模块
```

---

## 反编译

```bash
python -m decompile target.pyc --format text   # 反编译
python -m decompile target.pyc --detect        # 仅格式检测
python -m decompile --tools                    # 查看可用工具
```

支持：pyc / APK / DEX / JAR / PE / ELF / Mach-O / WASM / Lua / .NET。无外部工具时自动降级到 Python `dis` 反汇编。

---

## 许可证

Apache 2.0
