# 玄姝 (Xuanshu) — 多 Agent 协作系统 v0.0.0.2

[![Python](https://img.shields.io/badge/Python-3.8+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Flask-3.x-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
[![SSE](https://img.shields.io/badge/协议-SSE-FF6B35)](#)
[![REST](https://img.shields.io/badge/协议-REST-009688)](#)
[![SQLite](https://img.shields.io/badge/存储-SQLite-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License](https://img.shields.io/badge/License-GPL%20v3%20%2B%20Apache%202.0-blue.svg)](LICENSE)

> 父 Bot 意图路由 → 子 Agent 工具调用 → 思考链流式输出 → Skill 自学习

---

## 这是什么

玄姝是一个运行在本地的多 Agent 协作系统。一个请求进来之后，不是单一大模型直接回答——而是由**父 Bot** 分析意图，路由到最合适的**子 Agent**（搜索/代码/文件/电脑/应用），子 Agent 自主调用工具完成任务，整个过程通过 SSE 实时推送到前端展示。

核心思路：不让一个模型干所有事，而是让「路由者」+「执行者」各司其职，复杂任务走协调者四阶段流水线。

---

## 工作流程

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

## 核心组件

### 父 Bot（ParentBot）

入口只有一个：`ParentBot.process_input()`。它做了三件事：

1. **意图路由**：用 `ROUTER_PROMPT` 让 LLM 判断该交给哪个子 Agent。路由提示词定义了每个 Agent 的职责边界，LLM 只输出目标 Agent 名称。

2. **Continue / Fresh 判定**：每次请求检查当前活跃的 Agent 上下文——如果新请求和上次任务的上下文重叠度高（同 Agent + 相关主题），复用已有对话历史（Continue）；否则新开会话（Fresh）。上下文通过 `_agent_contexts` 字典追踪。

3. **协调者模式调度**：检测到复杂任务（命中关键词如"研究/实现/构建/部署" + 长度 > 30 字符 + 非简单问答），自动走四阶段流水线。

### 子 Agent（ChildBot）

5 个子 Agent，每个都有独立的记忆、工具集、人格宪法：

| Agent | 职责 | 工具（部分） |
|-------|------|-------------|
| 搜索Agent | 联网搜索、百科、天气、网页抓取 | web_search, search_wikipedia, web_fetch, weather |
| 代码Agent | 编程、调试、shell 执行、沙箱运行 | shell_run, sandbox_run, screen_capture, git_log, git_revert |
| 文件Agent | 文件读写、反编译、项目结构分析 | read_file, write_file, list_dir, decompile, file_search, grep |
| 电脑Agent | 系统信息、进程管理、资源监控 | sys_info, process_list, process_kill, disk_usage, memory_usage, cpu_info, network_info |
| 应用Agent | 软件包管理（dnf/yum） | pkg_search, pkg_list, pkg_info, pkg_install, pkg_remove, pkg_update |

所有 Agent 共享一套通用工具：`memdir_*`（共享记忆文件夹读写）和 `git_*`（版本回滚）。

### 常量模块

- `MONITOR_INTERVAL`：指标收集间隔
- `MEMORY_FILE`：Agent 自身经验存储（MEMORY.md），Hermes Agent 风格，硬限制 8000 字符
- `USER_FILE`：用户画像文件（USER.md），硬限制 3000 字符
- `MAX_RETRIES`：工具调用最大重试次数 = 2
- `RETRY_DELAY`：重试间隔 = 1.0s
- `CONTEXT_OVERLAP_THRESHOLD`：Continue 判定用上下文重叠阈值
- `SEARCH_RESULT_LIMIT`：搜索结果截断条数 = 5

### 人格宪法（Constitution）

每个子 Agent 启动时注入 `CONSTITUTION_TEMPLATE`，定义其：

- **核心价值观**：批判性审视信息来源、独立判断、透明度、好奇心、立场、成长
- **表达风格**：口语化自然语言、段落简短、展现思考过程
- **行为边界**：不伤害、不造谣、不绕过安全限制
- **工具使用方式**：调用前后必须用自己的语言表达判断，工具返回后自我反思

搜索/代码/文件 Agent 各自有专属的 `ROLE_SPECIFICS` 补充。

### 工具调用链路

```
LLM 输出 tool_call
    │
    ▼
_dispatch_tool_call()
    ├── 1. 解析 function.name + function.arguments (JSON 容错：去垃圾/去尾逗号)
    ├── 2. 模糊匹配工具名 (精确→子串→编辑距离，阈值 0.5)
    ├── 3. 参数校验 + 默认值填充
    └── 4. ToolExecutor.execute()
            ├── 重试 (最多 2 次，间隔 1s/2s)
            └── 降级 (web_search → search_wikipedia → web_fetch)
```

### Skill 自学习

- **触发**：任意 Agent 完成 ≥ 4 轮工具调用的任务
- **提炼**：调用 LLM 从任务经验中提取 Markdown 格式 Skill 文档
- **存储**：写入 `子Agent专有目录/.memdir/search|code|file/skills/*.md`
- **检索**：新任务时，用 jieba 分词 + TF-IDF 向量 + 余弦相似度匹配历史 Skill，注入到 Agent 上下文
- **持久化**：SQLite 存向量索引，Markdown 文件存内容

### 记忆系统

三层记忆架构：

| 层 | 存储 | 说明 |
|----|------|------|
| 短期 | Agent 对话历史 (JSON) | 当前会话上下文 |
| 中期 | 子 Agent 独立记忆文件 | `.memory/{agent}.json` |
| 长期 | MEMORY.md + USER.md | Agent 自身经验 + 用户画像 |

共享记忆文件夹 (`MemdirStore`) 提供跨 Agent 的任意格式文件读写，包括快照导出功能。

---

## 启动方式

### Web 界面（推荐）

```bash
bash xuanshu
# 访问 http://localhost:8901
```

`xuanshu` 脚本自动完成：检测 Python ≥ 3.8 → 创建 `.venv` → pip install → 启动 Flask 服务。

手动启动：
```bash
source .venv/bin/activate
python frontend.py
```

### 命令行

```bash
source .venv/bin/activate
python main.py
```

### systemd 服务

```bash
sudo cp xuanshu.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xuanshu
```

---

## 模型配置

在 Web 界面设置页填入 API Key 并选择模型。也可设为 `local`（本地模拟模式，免 Key）。

### 直连官方 API

| 厂商 | 标签 / 模型 |
|------|------------|
| OpenAI | 旗舰 1.1M上下文 `gpt-5.5`、极致推理 `gpt-5.5-pro`、多模态旗舰 `gpt-4o`、轻量多模态 `gpt-4o-mini` |
| Anthropic | 旗舰 1M上下文 `claude-opus-4.8`、速度智能平衡 `claude-sonnet-4.6`、最快 `claude-haiku-4.5`、Mythos级 `claude-fable-5` |
| Google | 旗舰多模态 `gemini-3.1-pro`、默认首选 `gemini-3-flash` |
| DeepSeek | 旗舰 1M上下文 `deepseek-v4-pro`、高性价比 `deepseek-v4-flash`、旧版 `deepseek-v3`、旧版推理 `deepseek-r1` |
| 阿里通义 | 最新旗舰 `qwen3.7-max`、Plus版 `qwen3.7-plus`、开源千亿 `qwen2.5-72b`、高性价比 `qwen2.5-32b` |
| 智谱 GLM | MoE 744B MIT开源 `glm-5.2`、旗舰付费 `glm-4.7`、轻量 `glm-4.7-flash`、轻量低成本 `glm-4-air` |
| 月之暗面 | 200万字上下文 `moonshot-v1`、增强推理 `kimi-k2` |
| 字节豆包 | 旗舰通用 `doubao-pro`、轻量低成本 `doubao-lite` |
| 百川 | 通用多模态 `baichuan4` |
| MiniMax | 多模态语音(旧) `abab6.5`、最新原生多模态 `minimax-m3`、自主迭代旗舰 `minimax-m2.7`、高速版 `minimax-m2.7-fast` |
| 零一万物 | 千亿参数 `yi-large` |
| 讯飞星火 | 多模态 `spark-4.0` |
| 腾讯混元 | 旗舰多模态 `hunyuan-pro` |
| Mistral | 多语言/函数调用 `mistral-large`、轻量快速 `mistral-small` |
| Meta | 官方托管 `llama-4`、70B `llama-3.3` |
| xAI | 实时联网 `grok-3` |
| Cohere | 企业级RAG `command-r-plus` |
| NVIDIA | 120B `nemotron-super` |
| AI21 | Mamba混合架构 `jamba-1.6` |
| Reka | 多模态快速 `reka-flash` |

### 聚合平台

可通过以下平台接入更多模型（详见 `models.py`）：

- **NVIDIA NIM** — MiniMax-M2.7、MiniMax-M3
- **SiliconFlow** — Qwen3.7/GLM-5.2/DeepSeek-V4/Kimi-K2/MiniMax-M1 等 40+ 国产模型
- **OpenRouter** — DeepSeek-V4/Gemini/Claude/Llama/Qwen3.7/Nemotron 等 30+ 海外模型
- **Groq** — Llama-4 超快推理
- **Together AI** — 开源模型托管

### 本地推理

- **Ollama** / **LM Studio** / **vLLM** — 接入本地部署模型，数据不出机

---

## API 端点

### 对话

| 端点 | 方法 | 说明 |
|------|------|------|
| `/chat` | POST | 同步对话，返回 `{reply, thinking, agent}` |
| `/chat/stream` | POST | SSE 流式对话，实时文本 + 思考链事件 |

### 模型 & Key

| 端点 | 方法 | 说明 |
|------|------|------|
| `/models` | GET/POST | 列出/添加模型 |
| `/models/<key>` | DELETE | 删除自定义模型 |
| `/set-key` | POST | 设置 API Key |
| `/model-key` | POST | 为指定模型设置 Key |
| `/model-key/status` | GET | Key + 模型状态 |
| `/switch-model` | POST | 切换当前模型 |

### 记忆 & 上下文

| 端点 | 方法 | 说明 |
|------|------|------|
| `/memory/list` | GET | 列出所有记忆 |
| `/memory/read` | POST | 读取指定记忆 |
| `/memory/write` | POST | 写入记忆 |
| `/memory/delete` | POST | 删除记忆 |
| `/context` | GET | 获取持久化上下文 |
| `/context/save` | POST | 保存上下文 |
| `/snapshots/export` | POST | 导出记忆快照 |
| `/snapshots/import` | POST | 导入记忆快照 |

### 文件

| 端点 | 方法 | 说明 |
|------|------|------|
| `/browse` | POST | 浏览文件夹 |
| `/file/read` | POST | 读取文件内容 |
| `/read-file` | POST | 读取文件（备用） |

### 系统 & 工具

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/check_env` | GET | 检查工具环境 |
| `/api/presets` | GET | 获取预设操作 |
| `/api/run` | POST | 执行命令 |
| `/agents` | GET | 列出可用 Agent |
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
├── core.py              父 Bot + 协调者 + 子 Agent + Skill 系统 (3216行)
├── frontend.py           Flask 后端 + REST API + SSE (726行)
├── models.py             128+ 模型预设
├── memory.py             子 Agent 独立记忆 + 上下文持久化
├── web_search.py         联网搜索 (DuckDuckGo Lite)
├── monitor.py            性能监控
├── logger.py             日志模块
├── light_server.py       轻量 HTTP Server
├── sandbox.py            沙箱执行环境
├── auto_sandbox.py       自动沙箱检测
├── screen_reader.py      屏幕截图读取
├── main.py               命令行入口
├── index.html            Web 前端
├── style.css             样式
├── xuanshu               一键启动脚本
├── xuanshu.service       systemd 服务
├── requirements.txt      依赖清单
├── .memdir/              共享记忆文件夹
│   └── snapshots/        记忆快照导出
├── .memory/              子 Agent JSON 记忆
├── .skills/              手动 Skill (REST API)
└── decompile/            反编译模块
    ├── __init__.py
    ├── __main__.py
    └── format_detector.py
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

## 环境要求

- Python 3.8+
- Linux（macOS / WSL 可用）

---

## 数据所有权

全部数据存储在本地文件系统（`.memdir/`、`.memory/`、`.skills/`）。无遥测、无上报、无云端同步。删除对应目录即可清除。

---

## 许可证

GPL v3 + Apache 2.0
