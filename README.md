# 玄姝 (Xuanshu) — 多 Agent 协作系统 v0.0.0.2

[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Flask-3.x-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
[![SSE](https://img.shields.io/badge/协议-SSE-FF6B35?logo=serverless&logoColor=white)](#)
[![REST](https://img.shields.io/badge/协议-REST-009688?logo=fastapi&logoColor=white)](#)
[![TF-IDF](https://img.shields.io/badge/检索-TF--IDF-FF6F00?logo=scikitlearn&logoColor=white)](#)
[![SQLite](https://img.shields.io/badge/存储-SQLite-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License](https://img.shields.io/badge/License-GPL%20v3%20%2B%20Apache%202.0-blue.svg)](LICENSE)

父 Bot 路由 → 子 Agent 执行 → 协调者编排 → 思考链可视化 → Skill 自学习。

## 功能

### Agent 协作

| 功能 | 说明 |
|------|------|
| 意图路由 | 父 Bot 自动分派给搜索/代码/文件三类子 Agent |
| 协调者模式 | Research → Synthesis → Implementation → Verification 四阶段工作流 |
| Continue/Fresh | 基于上下文重叠度自动判断复用会话还是新开会话 |
| 自校验 | 代码类 Agent 执行后自动验证结果 |

### 思考链

| 功能 | 说明 |
|------|------|
| SSE 流式传输 | LLM 思考过程实时推送到前端 |
| 思考链面板 | 折叠面板展示每轮工具调用的思考内容 |
| 工具追踪 | 显示当前执行工具名 + 轮次 |

### Skill 系统

| 功能 | 说明 |
|------|------|
| 自动学习 | 复杂任务（≥5 轮工具调用）完成后自动提炼 Skill |
| 向量检索 | TF-IDF + 余弦相似度，SQLite 持久化 |
| REST API | 手动创建/列出/读取/删除 Skill，按 Agent 隔离 |

### 记忆管理

| 功能 | 说明 |
|------|------|
| 独立记忆 | 每个子 Agent 独立记忆空间 |
| 快照 | 导出/导入所有子 Agent 记忆 |
| 上下文持久化 | 关闭页面后重新打开可恢复对话 |

### 模型支持

128+ 模型内置，覆盖 OpenAI / Anthropic / DeepSeek / 通义千问 / 智谱 / 豆包 / MiniMax / SiliconFlow / OpenRouter / NVIDIA / Ollama 等。

### 反编译

| 功能 | 说明 |
|------|------|
| 多格式 | pyc / APK / DEX / JAR / PE / ELF / Mach-O / WASM / Lua / .NET |
| 降级兜底 | 无外部工具时自动降级到 Python 内置 dis 反汇编 |
| CLI | `python -m decompile target --format text` |

## 数据所有权

- **输入数据**：用户输入的消息、上传的文件、配置的 API Key 归用户所有，仅存储在本地 `.memdir/` 和 `.skills/` 目录中
- **输出数据**：Agent 生成的回复、文件、记忆、Skill 归用户所有，全部保存在本地文件系统
- **不收集**：本系统不包含任何遥测、埋点、数据上报或云端同步逻辑
- **不上传**：除用户主动配置的第三方 LLM API 调用外，不向任何外部服务器传输数据
- **API 调用**：对话时仅将当前消息发送给用户指定的模型服务商，调用完成后不保留服务端日志
- **可删除**：删除 `.memdir/` 和 `.skills/` 目录即可清除所有本地数据

## 环境要求

- Python 3.11+
- Linux / macOS

## 安装

```bash
git clone https://github.com/l1064709321/xuanshuAgent.git
cd xuanshuAgent
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 启动

### Web 界面（推荐）

```bash
bash run.sh
# 浏览器打开 http://localhost:8901
```

或手动启动：

```bash
source .venv/bin/activate
python frontend.py
```

### 命令行模式

```bash
source .venv/bin/activate
python main.py
# /help 查看命令
```

启动后在界面选择模型并填入 API Key。设为 `local` 可使用本地模拟模式（无需 Key）。

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | Web 前端界面 |
| `/chat` | POST | 对话，返回 `{reply, thinking, agent}` |
| `/chat/stream` | POST | 流式对话（SSE），实时输出文本 + 思考链事件 |
| `/models` | GET/POST | 查看/添加模型配置 |
| `/models/<key>` | DELETE | 删除自定义模型 |
| `/set-key` | POST | 设置 API Key |
| `/switch-model` | POST | 切换当前模型 |
| `/model-key/status` | GET | 查看当前 Key 和模型状态 |
| `/coordinator-mode` | POST | 切换协调者模式 |
| `/browse` | POST | 浏览服务器本地文件夹 |
| `/context` | GET | 获取持久化对话上下文 |
| `/context/save` | POST | 保存对话上下文 |
| `/snapshots/export` | POST | 导出所有子 Agent 记忆快照 |
| `/snapshots/import` | POST | 导入记忆快照 |
| `/agents` | GET | 列出可用子 Agent |
| `/metrics` | GET | 性能指标 |

## 项目结构

```
xuanshuAgent/
├── frontend.py       Flask 后端 + REST API + SSE 流式
├── core.py           父 Bot + 协调者 + 子 Agent + SkillStore
├── models.py         模型池定义（128+ 模型）
├── memory.py         子 Agent 独立记忆 + 快照管理
├── web_search.py     联网搜索
├── monitor.py        性能监控
├── logger.py         日志模块
├── main.py           命令行入口
├── run.sh            一键启动脚本（含 venv 创建）
├── start             旧版启动脚本
├── index.html        Web 前端界面
├── .memdir/          子 Agent 持久记忆
│   ├── skills/       自动学习 Skill
│   └── snapshots/    记忆快照
├── .skills/          手动 Skills（REST API）
└── decompile/        反编译模块
    ├── __init__.py   统一反编译接口
    ├── __main__.py   CLI 入口
    └── format_detector.py  魔数格式检测
```

## 反编译模块

```bash
# 查看可用工具
python -m decompile --tools

# 仅检测格式
python -m decompile target. pyc --detect

# 反编译
python -m decompile target. pyc --format text
```

内置 dis 反汇编降级，即使未安装外部工具也能处理 .pyc 文件。
