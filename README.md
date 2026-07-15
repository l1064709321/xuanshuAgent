# 玄姝 (Xuanshu) — 多 Agent 协作系统 v0.0.0.2

[![Python](https://img.shields.io/badge/Python-3.8+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Flask-3.x-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
[![SSE](https://img.shields.io/badge/协议-SSE-FF6B35)](#)
[![REST](https://img.shields.io/badge/协议-REST-009688)](#)
[![TF-IDF](https://img.shields.io/badge/检索-TF--IDF-FF6F00)](https://scikit-learn.org/)
[![SQLite](https://img.shields.io/badge/存储-SQLite-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License](https://img.shields.io/badge/License-GPL%20v3%20%2B%20Apache%202.0-blue.svg)](LICENSE)

**玄姝** 是一个运行在你本地的轻量级多 Agent 协作系统。它接收自然语言指令，自动路由给最合适的子 Agent 执行——搜索资料、编写代码、处理文件、运行命令——并通过 Web 界面实时展示执行过程和思考链。

如果你需要的是一个能联网搜索、能写代码、能管理文件、还能从历史任务中自学习的人工智能助手，而不是每次对话都从零开始的聊天机器人，玄姝就是为此设计的。

---

## 为什么选择玄姝

- **本地运行**：代码和数据完全在你自己的机器上，无需上传到任何云端服务
- **Agent 协作**：父 Bot 智能路由 → 搜索/代码/文件子 Agent 各司其职，不是单一模型包办一切
- **思考链可视**：通过 SSE 实时流式展示 LLM 的推理过程，每一步工具调用都有据可查
- **自学习**：复杂任务完成后自动提炼为 Skill，下次遇到类似需求直接复用，越用越聪明
- **模型自由**：内置 128+ 模型配置，支持 OpenAI / Anthropic / DeepSeek / 通义千问 / 智谱 / 豆包 / Ollama 等，也可设为本地模拟模式免 Key 运行
- **多入口**：提供 Web 界面、命令行模式、REST API 三种交互方式，适合不同场景

---

## 架构概览

```
用户输入
  │
  ▼
┌─────────────┐    意图路由    ┌─────────────────────────┐
│   父 Bot     │ ────────────→ │  搜索Agent / 代码Agent   │
│  (Flask)     │               │        / 文件Agent       │
└─────────────┘               └───────────┬─────────────┘
       │                                  │
       │  SSE 流式                        │  工具调用
       ▼                                  ▼
┌─────────────┐               ┌─────────────────────────┐
│  思考链面板  │               │  协调者模式 (可选)        │
│  实时可视化  │               │  Research → Synthesis    │
│             │               │  → Implementation        │
│             │               │  → Verification          │
└─────────────┘               └─────────────────────────┘
```

## 功能详解

### Agent 协作

| 功能 | 说明 |
|------|------|
| 意图路由 | 父 Bot 分析用户输入，自动分派给搜索/代码/文件子 Agent |
| 协调者模式 | Research → Synthesis → Implementation → Verification 四阶段工作流，适合复杂多步骤任务 |
| Continue/Fresh | 基于上下文重叠度自动判断复用已有会话还是新开会话 |
| 自校验 | 代码类 Agent 执行后自动验证结果正确性 |
| 多轮工具调用 | 子 Agent 可自主进行多轮工具调用（搜索 → 读取 → 分析），结果自动汇总 |

### 思考链可视化

| 功能 | 说明 |
|------|------|
| SSE 流式传输 | LLM 思考过程通过 Server-Sent Events 实时推送到前端 |
| 折叠面板 | 每轮工具调用的思考内容以折叠面板展示，支持展开/收起 |
| 工具追踪 | 实时显示当前执行工具名称和执行轮次 |
| 连接状态 | 前端显示 API 连接状态（已连接/未连接），绿色/灰色圆点指示 |

### Skill 自学习系统

| 功能 | 说明 |
|------|------|
| 自动提炼 | 复杂任务（≥5 轮工具调用）完成后自动提炼为 Skill |
| 向量检索 | TF-IDF + 余弦相似度检索，SQLite 持久化存储 |
| 手动管理 | REST API 创建/列出/读取/删除 Skill，按 Agent 隔离 |
| 语义召回 | 新任务自动匹配历史 Skill，复用成功经验 |

### 记忆系统

| 功能 | 说明 |
|------|------|
| 独立记忆 | 每个子 Agent 拥有独立记忆空间，互不干扰 |
| 快照管理 | 支持导出/导入所有子 Agent 记忆快照 |
| 上下文持久化 | 关闭页面后重新打开可恢复历史对话 |
| JSON 存储 | 记忆以 JSON 格式持久化在 `.memdir/` 目录 |

### 模型支持

内置 **128+ 模型**配置，覆盖以下厂商：

| 厂商 | 模型示例 |
|------|---------|
| OpenAI | gpt-4o, gpt-4-turbo, gpt-3.5-turbo |
| Anthropic | claude-3.5-sonnet, claude-3-opus |
| DeepSeek | deepseek-chat, deepseek-reasoner |
| 通义千问 | qwen-max, qwen-plus |
| 智谱 GLM | glm-4, glm-4v |
| 豆包 | doubao-pro-32k |
| MiniMax | abab6.5s-chat |
| SiliconFlow | 多款开源模型 API |
| OpenRouter | 聚合多厂商路由 |
| NVIDIA NIM | nemotron 系列 |
| Ollama | 本地部署模型（llama3, mistral 等） |

### 反编译模块

| 功能 | 说明 |
|------|------|
| 多格式支持 | pyc / APK / DEX / JAR / PE / ELF / Mach-O / WASM / Lua / .NET |
| 降级兜底 | 无外部工具时自动降级到 Python 内置 `dis` 反汇编 |
| CLI 入口 | `python -m decompile target --format text` |
| 格式检测 | 基于魔数自动识别文件格式 |

### Git 管理

| 功能 | 说明 |
|------|------|
| 日志查看 | `/git-log` 查看最近提交记录 |
| 状态检查 | `/git-status` 查看工作区和暂存区状态 |
| 版本回退 | `/git-revert` 回退到指定 commit |
| 撤销回退 | `/git-revert-restore` 恢复被回退的提交 |

---

## 环境要求

- Python 3.8+
- Linux / macOS / Windows (WSL)

---

## 快速开始

### 1. 克隆仓库

```bash
git clone https://gitee.com/lord-of-the-star/xuan-shu-agent.git
cd xuanshuAgent
```

### 2. 一键启动

```bash
bash xuanshu
# 自动完成：创建虚拟环境 → 安装依赖 → 启动服务
# 浏览器打开 http://localhost:8901
```

### 3. 手动安装

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python frontend.py
```

### 4. 命令行模式

```bash
source .venv/bin/activate
python main.py
# 输入 /help 查看可用命令
```

### 5. 配置模型

启动后在 Web 界面的 **设置** 页面：
1. 输入 API Key（如 OpenAI 的 `sk-xxxx`）
2. 点击「应用 Key」
3. 在模型列表中选择模型
4. 设为 `local` 可使用本地模拟模式（无需 Key）

---

## 部署为系统服务

```bash
sudo cp xuanshu.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable xuanshu    # 开机自启
sudo systemctl start xuanshu     # 立即启动

# 常用命令
sudo systemctl status xuanshu    # 查看状态
journalctl -u xuanshu -f         # 实时日志
```

**注意**：部署前修改 `xuanshu.service` 中的 `User` 和 `WorkingDirectory` 为实际值。

---

## API 完整参考

### 对话

| 端点 | 方法 | 说明 |
|------|------|------|
| `/chat` | POST | 对话，返回 `{reply, thinking, agent}` |
| `/chat/stream` | POST | 流式对话（SSE），实时输出 + 思考链事件 |

### 模型管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/models` | GET | 列出所有可用模型 |
| `/models` | POST | 添加自定义模型 |
| `/models/<key>` | DELETE | 删除自定义模型 |
| `/set-key` | POST | 设置 API Key |
| `/switch-model` | POST | 切换当前模型 |
| `/model-key` | POST | 为指定模型设置独立 Key |
| `/model-key/status` | GET | 查看当前 Key 和模型状态 |

### 记忆

| 端点 | 方法 | 说明 |
|------|------|------|
| `/memory/list` | GET | 列出所有记忆文件 |
| `/memory/read` | POST | 读取指定记忆内容 |
| `/memory/write` | POST | 写入记忆 |
| `/memory/delete` | POST | 删除记忆 |
| `/context` | GET | 获取持久化对话上下文 |
| `/context/save` | POST | 保存对话上下文 |
| `/snapshots/export` | POST | 导出所有子 Agent 记忆快照 |
| `/snapshots/import` | POST | 导入记忆快照 |

### Skill

| 端点 | 方法 | 说明 |
|------|------|------|
| `/skills/list` | POST | 列出指定 Agent 的 Skill |
| `/skills/read` | POST | 读取 Skill 详情 |
| `/skills/create` | POST | 手动创建 Skill |
| `/skills/delete` | POST | 删除 Skill |

### 文件

| 端点 | 方法 | 说明 |
|------|------|------|
| `/browse` | POST | 浏览服务器本地文件夹 |
| `/file/read` | POST | 读取文件内容 |
| `/read-file` | POST | 读取文件（备用） |

### 工具 & 系统

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/check_env` | GET | 检查工具环境 |
| `/api/presets` | GET | 获取预设操作列表 |
| `/api/run` | POST | 执行自定义命令 |
| `/agents` | GET | 列出可用子 Agent |
| `/metrics` | GET | 性能指标 |
| `/coordinator-mode` | POST | 切换协调者模式 |

### Git

| 端点 | 方法 | 说明 |
|------|------|------|
| `/git-log` | GET | 查看提交日志 |
| `/git-status` | GET/POST | 查看/更新工作区状态 |
| `/git-revert` | POST | 回退到指定 commit |
| `/git-revert-restore` | POST | 撤销回退 |

---

## 项目结构

```
xuanshuAgent/
├── frontend.py        Flask 后端 + REST API + SSE 流式输出
├── core.py            父 Bot 路由 + 协调者编排 + 子 Agent 管理 + SkillStore
├── models.py          模型池（128+ 厂商/模型配置）
├── memory.py          子 Agent 独立记忆 + 快照管理
├── web_search.py      联网搜索模块
├── monitor.py         性能监控（token 用量、响应时间）
├── logger.py          日志模块
├── main.py            命令行交互入口
├── light_server.py    轻量 Server 实现
├── sandbox.py         沙箱执行环境
├── auto_sandbox.py    自动沙箱检测
├── screen_reader.py   屏幕阅读辅助
├── index.html         Web 前端界面（响应式，支持桌面/移动端）
├── style.css          样式表
├── xuanshu            一键启动脚本（自动创建 venv + 安装依赖）
├── xuanshu.service    systemd 服务文件
├── start              旧版启动脚本
├── requirements.txt   Python 依赖清单
├── .memdir/           子 Agent 持久记忆
│   ├── skills/        自动学习 Skill
│   └── snapshots/     记忆快照
├── .skills/           手动 Skills（REST API 管理）
└── decompile/         反编译模块
    ├── __init__.py    统一反编译接口
    ├── __main__.py    CLI 入口
    └── format_detector.py  魔数格式检测
```

---

## 反编译模块

```bash
# 查看可用反编译工具
python -m decompile --tools

# 仅检测文件格式（不反编译）
python -m decompile target.pyc --detect

# 反编译为文本
python -m decompile target.pyc --format text

# 支持格式
# .pyc → Python 反编译 / dis 反汇编（兜底）
# .apk / .dex → jadx / d2j
# .jar → cfr / procyon
# .exe / .dll → dotPeek / ILSpy
# ELF / Mach-O → objdump / Ghidra
# .wasm → wasm-decompile
# .lua → luadec
```

内置 `dis` 反汇编降级，即使未安装任何外部工具也能处理 `.pyc` 文件。

---

## 数据所有权

| 项目 | 说明 |
|------|------|
| 输入数据 | 用户消息、上传文件、API Key 归用户所有，仅存本地 |
| 输出数据 | Agent 回复、生成文件、记忆、Skill 归用户所有 |
| 不收集 | 无遥测、无埋点、无数据上报、无云端同步 |
| 不上传 | 除用户配置的 LLM API 调用外，无外部传输 |
| API 调用 | 仅当前消息发送给模型服务商，无服务端日志留存 |
| 可删除 | 删除 `.memdir/` 和 `.skills/` 目录即清除所有本地数据 |

---

## 常见问题

**Q: 启动报 "未找到 Python 3.8+"？**
```bash
sudo apt install python3 python3-venv python3-pip  # Debian/Ubuntu
```

**Q: `pip install` 报权限错误？**
```bash
rm -rf .venv && python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

**Q: `wikipedia` 安装失败？**
不影响核心功能，跳过即可：`pip install flask requests`

**Q: 如何远程访问？**
服务器启动后已监听 `0.0.0.0:8901`，通过 `http://服务器IP:8901` 访问（需开放防火墙端口）。

**Q: 端口被占用？**
```bash
lsof -i :8901          # 查看占用进程
kill -9 <PID>          # 结束进程
```

---

## 许可证

本项目采用 **GPL v3 + Apache 2.0** 双许可证，详见 [LICENSE_GNU](LICENSE_GNU) 和 [LICENSE-apache](LICENSE-apache)。
