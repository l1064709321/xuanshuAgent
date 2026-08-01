# 玄姝 (Xuanshu) — 多 Agent 协作系统

[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Flask-3.x-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
[![Docker](https://img.shields.io/badge/Docker-✓-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

玄姝是一个多 Agent 协作系统。群主「玄姝」分析用户问题，@副手执行任务，每个 Agent 有独立名字、工具集和记忆。

---

## 快速开始

### Docker（推荐）

```bash
git clone https://gitee.com/l1064709321/xuanshuAgent.git
cd xuanshuAgent
docker compose up -d
```

访问 http://localhost:8901。

### 手动安装

```bash
git clone https://gitee.com/l1064709321/xuanshuAgent.git
cd xuanshuAgent
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
python frontend.py
```

### 开发模式

源码修改实时生效，无需重新 build：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

---

## 群聊模式

玄姝是群主，负责分析问题和派发任务。六个副手各有专长：

| 名字 | 角色 | 职责 | 工具 |
|------|------|------|------|
| **玄姝** | 群主 | 意图分析、任务派发、结果汇总 | 路由、文件操作 |
| **小搜** | 搜索 | 联网搜索、天气、百科、网页抓取 | anysearch, web_fetch, wikipedia |
| **小码** | 编程 | 写代码、调试、Git 版本回滚 | run_code, run_code_venv, create_venv |
| **小文** | 文件 | 文件读写、反编译、文档处理 | read_file, decompile, git_log |
| **小览** | 浏览器 | 网页交互、点击、填表、截图 | browser_navigate, browser_click |
| **小屏** | 系统 | 进程管理、磁盘、网络、包管理 | sys_info, process_list, pkg_install |
| **小手机** | 手机 | ADB 操控 Android 设备 | adb_tap, adb_screenshot, adb_type |

前端显示效果：

```
┌─────────────────────────────────┐
│ 玄姝 → @小搜                     │  ← Agent 标签
│                                 │
│ ✦ 思考链                        │
│   #1 🔍 anysearch  [搜索]       │
│   #2 🌐 web_fetch  [抓取]       │
│                                 │
│ 根据最新搜索结果...              │
└─────────────────────────────────┘
```

---

## 思考链

每个 Agent 的工具调用过程实时展示：

- 赛博朋克风格时间线，左侧发光节点 + 连线
- 40+ 工具专属图标和分类色标（搜索=绿、代码=紫、浏览器=粉、系统=红）
- 逐步淡入动画，最后一步呼吸脉冲
- 内容 `user-select: none`，不可选中复制

---

## 代码执行环境

小码根据任务自动选择执行环境：

| 模式 | 场景 | 网络 | 文件 | 依赖 |
|------|------|------|------|------|
| `run_code` (sandbox) | 不信任的代码 | ❌ | ❌ 只读 | 仅标准库 |
| `run_code_venv` | 需要 pip 包 | ✅ | ✅ | venv 里的包 |
| `run_code_local` | 完全信任 | ✅ | ✅ | 当前环境全部 |

```python
# 小码自动决策：
# 简单计算 → sandbox
# 需要 requests/numpy → 先 create_venv → 再 run_code_venv
# 已有 .venv → 直接 run_code_venv
```

---

## 前端功能

### 输入框

椭圆胶囊形，左侧 `+` 上传文件，右侧 `⚡` 切换模型 + `↑` 发送。

### 侧边栏

```
┌──────────────┐
│ ☰ 玄姝       │  ← 点击收起/展开
├──────────────┤
│ ♦ 对话       │
│ ♦ 设置       │
│ ♦ 个人主页   │
├──────────────┤
│ 会话         │
├──────────────┤
│ 📁 文件      │  ← 用户上传文件
├──────────────┤
│ 🧠 记忆      │  ← Agent 记忆（用户只读）
├──────────────┤
│ ⚡ 技能市场   │  ← 内置 + 已学 + 自定义
├──────────────┤
│ ⬤ 状态      │
└──────────────┘
```

### 头像抽屉

点头像 → 右侧滑出面板：头像上传、记忆文件浏览、快捷操作。

### 技能市场

- 内置技能：联网搜索、代码执行、文件管理等 8 项
- 已学习技能：Agent 自动提炼的经验
- 自定义技能：用户手动创建，绑定到指定 Agent

---

## 记忆系统

| 层级 | 存储 | 说明 |
|------|------|------|
| 短期 | Agent 对话历史 | 当前会话上下文 |
| 中期 | `.memory/{agent}.json` | 子 Agent 独立记忆 |
| 长期 | `MEMORY.md` + `USER.md` | Agent 经验 + 用户画像 |
| 共享 | `.memdir/` | 跨 Agent 文件级记忆 |

用户在侧边栏「🧠 记忆」中只读浏览，Agent 通过 `memdir_read`/`memdir_write` 工具读写。

---

## 模型配置

在设置页填入 API Key 并选择模型。支持 130+ 模型：

**直连官方**：OpenAI / Anthropic / Google / DeepSeek / 通义 / 智谱 / 月之暗面 / 豆包 / MiniMax / 腾讯混元 / Mistral / Meta / xAI

**聚合平台**：SiliconFlow（40+ 国产） / OpenRouter（30+ 海外） / NVIDIA NIM / Groq

**本地推理**：Ollama / LM Studio / vLLM

---

## Docker

### 生产模式

```bash
docker compose up -d        # 源码打包在镜像内
docker compose logs -f      # 查看日志
docker compose down          # 停止
```

数据持久化：`.memdir`、`.memory`、`workflows`、`workspace_files`、`.skills` 通过 named volumes 保存，容器销毁不丢数据。

### 开发模式

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

源码 bind mount，改代码实时生效。

### 环境变量

```yaml
environment:
  - AGNES_API_KEY=***       # Agnes 模型 Key
  - OPENAI_API_KEY=***      # OpenAI Key
  - JWT_SECRET=***          # JWT 签名密钥
```

---

## 项目结构

```
xuanshuAgent/
├── core.py              父 Bot + 群聊路由 + 子 Agent + Skill 系统
├── frontend.py          Flask 后端 + REST API
├── index.html           Web 前端
├── style.css            赛博朋克主题样式
├── models.py            130+ 模型预设 + 多模态路由
├── auth.py              手机号注册/登录 + JWT
├── memory.py            子 Agent 独立记忆
├── sandbox.py           多环境代码执行（sandbox/venv/local）
├── auto_sandbox.py      自动沙箱检测
├── workflow.py          工作流引擎
├── embeddings.py        Skill 向量检索
├── production.py        生产环境：Trace/Eval/Session/Checkpoint
├── config.py            配置
├── requirements.txt     依赖清单
├── Dockerfile           Docker 镜像
├── docker-compose.yml   生产模式
├── docker-compose.dev.yml  开发模式
├── .gitignore           排除敏感数据
├── .memdir/             共享记忆（不进仓库）
├── .memory/             Agent 记忆（不进仓库）
├── workflows/           用户工作流（不进仓库）
└── workspace_files/     用户文件（不进仓库）
```

---

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/chat` | POST | 对话 |
| `/chat/stream` | POST | SSE 流式对话 |
| `/models` | GET/POST | 列出/添加模型 |
| `/set-key` | POST | 设置 API Key |
| `/switch-model` | POST | 切换模型 |
| `/memory/*` | GET/POST | 记忆 CRUD |
| `/skills/*` | POST | 技能 CRUD |
| `/workspace/*` | POST | 文件管理 |
| `/agents` | GET | 列出 Agent |
| `/health` | GET | 健康检查 |
| `/auth/*` | POST | 注册/登录 |

---

## 许可证

Apache 2.0
