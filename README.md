# 玄姝 (Xuanshu) — 多 Agent 协作系统

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![SSE](https://img.shields.io/badge/协议-SSE-FF6B35)](#)
[![REST](https://img.shields.io/badge/协议-REST-009688)](#)
[![SQLite](https://img.shields.io/badge/存储-SQLite-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Docker](https://img.shields.io/badge/Docker-✓-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

> 全量 TypeScript 迁移版：核心逻辑、子 Agent、工具、路由均为 TS 实现。
> 仅保留少量 Python 脚本作为子进程执行引擎（沙箱 / PDF / TTS / 数据处理）。

## 快速开始

### 获取源码

| 源 | 克隆地址 |
|---|---------|
| **GitHub** | `https://github.com/l1064709321/xuanshuAgent.git` |
| Gitee（国内镜像） | `https://gitee.com/l1064709321/xuanshuAgent.git` |
| 华为云 CodeHub | `https://codehub.devcloud.cn-north-4.huaweicloud.com/8965d3a4483445cca386477c8d9dd196/xuanshu-agent.git` |

### 环境要求

| 组件 | 版本 | 是否必需 | 用途 |
|------|------|---------|------|
| Node.js | >= 20（推荐 22 LTS） | 必需 | 服务本体（Fastify + TypeScript） |
| npm | 随 Node 附带 | 必需 | 依赖安装、构建、启动脚本 |
| Python | 3.8+，命令为 `python3` | 可选 | 沙箱 / PDF / TTS / 数据处理子进程；缺失时对应工具不可用 |
| ffmpeg | 较新版本 | 可选 | TTS 音频合成与音视频处理 |
| Playwright 浏览器内核 | 随 npm 依赖提供 CLI | 可选 | 浏览器类工具，需 `npx playwright install chromium` |
| Docker + Compose v2 | 20.10+ | 可选 | 仅容器方式需要 |

> 仅启动服务本体只需 Node.js；Python / ffmpeg 缺失不影响服务启动，对应工具降级。可用 `/api/deps` 实时体检运行时依赖。

### 方式一：源码启动（推荐，Node 22 / Linux 实测通过）

```bash
git clone https://github.com/l1064709321/xuanshuAgent.git
cd xuanshuAgent

npm ci            # 或 npm install；国内网络可先 npm config set registry https://registry.npmmirror.com
npm run build     # tsc 编译到 dist/（dist/ 不入库，必须执行）
npm start         # 等价于 node dist/server.js

# 开发模式（免构建，tsx watch 热重载）
npm run dev
```

启动后访问 **http://localhost:8901** ，健康检查：

```bash
curl http://localhost:8901/health     # {"status":"ok","uptime":...}
```

可选：启用 Python 子进程能力（沙箱 / PDF / TTS / 数据工具）

```bash
pip3 install -r requirements.txt      # Debian/Ubuntu 系统 Python 需追加 --break-system-packages
```

可选：启用浏览器工具（Chromium 内核约 150MB）

```bash
npx playwright install chromium
# 不需要浏览器工具时，可在安装依赖阶段跳过内核下载：
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
```

### 方式二：Docker 启动

```bash
git clone https://github.com/l1064709321/xuanshuAgent.git
cd xuanshuAgent
docker compose up -d --build
docker compose logs -f
```

访问 http://localhost:8901 。镜像基于 `node:20-bookworm-slim`，内置 Node、Python3、ffmpeg、Chromium 与全部 npm / pip 依赖，源码在镜像内编译，宿主无需安装 Node。持久化卷覆盖记忆、模型 Key、工作流与工作区。

> 首次构建需拉取基础镜像与 Chromium 内核，视网络约 3–10 分钟，镜像约 1.2GB。只要服务本体可用 `docker build --build-arg INSTALL_BROWSER=0 -t xuanshu-agent:latest .` 跳过浏览器内核。

### 方式三：npm 打包 / 全局安装

项目已完整 npm 化，可直接构建为标准 npm 安装包（含 `bin/xuanshu` 全局命令）：

```bash
# 构建 + 打包（产出 xuanshu-agent-<version>.tgz）
npm run pack

# 本地/全局安装
npm install -g ./xuanshu-agent-<version>.tgz
xuanshu                # 全局命令启动，默认 0.0.0.0:8901

# 或通过 npx 直接运行
npx xuanshu-agent

# 发布到 npm registry（需先 npm login）
npm publish
```

打包白名单由 `package.json` 的 `files` 字段控制，包含：`dist/`（TS 编译产物）、`bin/`（CLI 入口）、前端静态资源（`index.html` / `style.css`）、运行时 Python 依赖（`sandbox.py` / `pdf_tools.py` / `tts_tools.py` / `data_tools.py` / `src/scripts/tts_gen.py`）、README 与 LICENSE。

> 全局安装同样要求 Node >= 20 且能访问 npm 源（生产依赖由 npm 自动安装）；包内只带 Python 脚本、不含 pip 依赖，需要 Python 能力时自行 `pip3 install -r requirements.txt`。

### 首次配置

1. 打开 http://localhost:8901 → 「设置 / 模型」页，选择模型并填入 API Key（Base URL 支持 OpenAI 兼容的聚合平台）；
2. Key 持久化在 `.data/keys.json`（Docker 方式请确认已挂载 `.data` 卷，见 `docker-compose.yml`）；
3. 也可用环境变量 `XS_API_KEY` 提供启动默认 Key。

### 监听端口与环境变量

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `XS_HOST` | `0.0.0.0` | 监听地址 |
| `XS_PORT` | `8901` | 监听端口 |
| `XS_API_KEY` | 空 | 启动默认模型 Key；页面设置的 Key 落盘 `.data/keys.json` |
| `PYTHON` | Linux/macOS `python3`，Windows `python` | 沙箱子进程解释器路径 |
| `XS_DEBUG` | `False` | 调试日志 |
| `XS_LOG_MAX_MB` / `XS_LOG_KEEP_KB` | `2` / `256` | 日志单文件上限与保留尾部 |

```bash
XS_PORT=9000 npm start        # 换端口启动
```

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

**简单任务**（"今天天气怎么样"）：父 Bot 直接路由到搜索 Agent，单 Agent 单轮执行。

**复杂任务**（"把项目里所有 TODO 注释提取出来写到文件"）：触发协调者模式，先研究文件结构 → 生成 spec → 按 spec 执行 → 验证结果。

---

## 核心架构

### 父 Bot

入口只有一个：`src/core/coordinator.ts`。

1. **意图路由**：让 LLM 判断该交给哪个子 Agent
2. **Continue / Fresh 判定**：检查当前活跃的 Agent 上下文，同 Agent + 相关主题则复用（Continue），否则新开（Fresh）
3. **协调者模式调度**：检测到复杂任务时自动走四阶段流水线

### 子 Agent

8 个子 Agent，每个都有独立的记忆、工具集、人格宪法：

| Agent | 职责 | 工具 |
|-------|------|------|
| 电脑 | 系统信息、进程管理、资源监控、软件包管理 | sys_info, process_list, process_kill, disk_usage, memory_usage, cpu_info, network_info, pkg_search, pkg_install, pkg_remove, pkg_update |
| 手机 | ADB 操控 Android 设备/模拟器 | adb_screenshot, adb_tap, adb_swipe, adb_input, adb_install, adb_launch |
| 搜索 | 联网搜索、实时信息、天气、百科 | web_fetch, web_search |
| 浏览器 | 端到端浏览器操控 | browser_open, browser_click, browser_type, browser_extract, browser_screenshot |
| 代码 | 编程、调试、shell 执行、沙箱 | run_code, git_log, git_revert, git_status |
| 文件 | 文件读写、搜索、项目结构分析 | file_read, file_write, file_list, file_search |
| 音频 | 音频处理、格式转换、裁剪、合并、TTS | audio_convert, audio_cut, audio_merge, audio_extract, audio_speed, audio_fade, audio_normalize, tts_speak, tts_list_voices |
| 视频 | 视频处理、格式转换、裁剪、压缩 | video_convert, video_cut, video_compress, video_fps |

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
            └── 降级 (web_fetch → web_search)
```

### Skill 自学习

- **触发**：任意 Agent 完成 ≥ 4 轮工具调用的任务
- **提炼**：LLM 从任务经验中提取 Markdown 格式 Skill 文档
- **存储**：写入子 Agent 专有目录 `.memdir/skills/*.md`
- **检索**：TF-IDF 向量 + 余弦相似度匹配历史 Skill

### 记忆系统

| 层级 | 存储 | 说明 |
|------|------|------|
| 短期 | Agent 对话历史 (JSON) | 当前会话上下文 |
| 中期 | 子 Agent 独立记忆 | `.memdir/{agent}/` |
| 长期 | MEMORY.md + USER.md | Agent 自身经验 + 用户画像 |

记忆支持原子写入 + 写前备份 + 软删除（回收区可恢复）。

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
- **agnes AI** — agnes-2.0-flash / agnes-2.5-flash（当前默认）

### 本地推理

- **Ollama** / **LM Studio** / **vLLM** — 接入本地部署模型，数据不出机

---

## 运维

### 运行时依赖扫描

后端提供实时依赖扫描接口，检测进程、端口、公网隧道、系统命令、Python 包、关键路径：

```bash
curl http://localhost:8901/api/deps
```

返回各依赖项在线状态与耗时，用于排查"服务时连时断"等环境问题。

### 辅助验收（Verifier）

子 Agent 交付后由独立的「审核Agent / 小核」复核，只采信实测证据（真跑代码、真查磁盘、真抽帧比对、真探链接），不采信口头声明。开关：Agent 注册表的 `self_verify`、调用方 `opts.verify`，以及环境变量 `XS_VERIFY=0` 全局关闭；`maxRepair` 控制返修轮数。

验收能力按当前环境自动降级，**未验项会在结论中显式列出，禁止把"没法验"当成"通过"**：

| 维度 | 依赖 | 缺失时的行为 |
|------|------|------|
| 产物真实性 | 无 | 磁盘不存在/0 字节 → 判不通过 |
| 代码可运行 | Python（沙箱） | 沙箱缺依赖时降级本地复跑并声明隔离性下降 |
| 媒体真实性 | ffmpeg/ffprobe | 无 ffmpeg 且任务要求文案 → 判不通过（无法核验） |
| 画面文字 | tesseract 或 rapidocr | 两者皆无 → 判不通过；有 OCR 但画面无文字且无语音可核 → 判不通过 |
| 语音内容 | whisper-cli / faster-whisper | 缺失时仅做画面侧核验并声明 |
| 引用可达性 | 网络 | 无网络时声明未验 |

画面文字 OCR 默认回退 Python `rapidocr-onnxruntime`（wheels 自带中文模型，无需系统 tesseract）；安装见 `requirements.txt`，注意用 `opencv-python-headless`，`opencv-python` 依赖 `libGL.so.1` 会在容器内 ImportError。

自测（13 条用例，含编造产物/编造运行结果/静帧冒充/文案缺失与错版等负样本，以及真实交付正样本）：

```bash
npm run test:verifier
```

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
git clone https://gitee.com/l1064709321/xuanshuAgent.git

# 方案 B：禁用 SSL 验证
GIT_SSL_NO_VERIFY=1 git clone --depth 1 https://github.com/l1064709321/xuanshuAgent.git

# 方案 C：wget 下载 zip
wget --no-check-certificate https://github.com/l1064709321/xuanshuAgent/archive/refs/heads/main.zip
unzip main.zip && mv xuanshuAgent-main xuanshuAgent
```

#### npm install 网络慢 / 编译错误

```bash
# 国内镜像
npm config set registry https://registry.npmmirror.com
npm ci
```

#### 启动报 Cannot find module '.../dist/server.js'

`dist/` 编译产物不入库，`npm start` 前必须先 `npm run build`；或改用免构建的 `npm run dev`。

#### 端口被占用（EADDRINUSE）

```bash
XS_PORT=9000 npm start        # 换端口启动
lsof -i:8901                  # 查看占用进程（macOS / Linux）
```

#### Docker 启动后页面打不开

1. `docker compose logs -f` 查看容器日志，确认出现 `玄姝(TS) 已启动: http://0.0.0.0:8901`；
2. `docker compose ps` 确认状态为 `healthy`（健康检查打 `/health`）；
3. 宿主 8901 被占用时改端口映射：`ports: ["9000:8901"]`；
4. 镜像为旧版（Dockerfile 曾指向已删除的 `frontend.py`）时执行 `docker compose up -d --build` 重建。

#### 浏览器工具报缺少内核

```bash
npx playwright install chromium
```

容器方式请保持构建默认 `INSTALL_BROWSER=1`，或进入容器内执行上述命令。

---

## API 端点

### 对话

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/chat` | POST | 同步对话（返回 reply + thinking） |
| `/api/chat/stream` | GET/POST | SSE 流式对话（实时思考链） |

### 模型 & Key

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/models` | GET/POST | 列出/添加模型 |
| `/api/model-key` | POST | 为模型设置 Key |
| `/api/model-key/status` | GET | Key + 模型状态 |
| `/api/switch-model` | POST | 切换当前模型 |

### 记忆 & 上下文

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/memory/list` | GET | 列出记忆 |
| `/api/memory/read` | POST | 读取记忆 |
| `/api/memory/write` | POST | 写入记忆（原子写 + 备份） |
| `/api/memory/delete` | POST | 删除记忆（软删除，可恢复） |
| `/api/memory/trash/list` | GET | 列出回收区 |
| `/api/memory/trash/restore` | POST | 恢复回收区记忆 |

### 系统 & 工具

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/deps` | GET | 运行时环境依赖实时扫描 |
| `/api/tts` | POST | TTS 语音合成 |
| `/ping` | GET | 心跳探测 |
| `/health` | GET | 健康检查 |
| `/api/vm` | POST | 虚拟机管理 |
| `/api/vm2` | POST | 虚拟机管理 v2 |

### Skill

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/skills/list` | POST | 列出 Skill |
| `/api/skills/read` | POST | 读取 Skill |
| `/api/skills/update` | POST | 更新 Skill |
| `/api/skills/delete` | POST | 删除 Skill |

### Git

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/git-log` | GET | 提交记录 |
| `/api/git-status` | GET/POST | 工作区状态 |
| `/api/git-revert` | POST | 版本回退 |

---

## 项目结构

```
xuanshuAgent/
├── src/
│   ├── server.ts            Fastify 入口（同源托管前端 + /api 路由）
│   ├── core/                父 Bot / 协调者 / 模型池 / 记忆守卫 / 沙箱 / VM 引擎
│   │   ├── coordinator.ts   父 Bot + 意图路由 + 协调者模式
│   │   ├── agents.ts        子 Agent 定义（人格宪法 + 工具集）
│   │   ├── modelPool.ts     模型池（177+ 预设）
│   │   ├── engine.ts        LLM 调用引擎（agnes/OpenAI 兼容）
│   │   ├── memGuard.ts      记忆安全守卫（路径校验 + 原子写 + 备份 + 软删除）
│   │   ├── sandbox.ts       Python 沙箱子进程执行引擎
│   │   └── vmEngine.ts      QEMU 虚拟机引擎（WHPX/HVF/TCG）
│   ├── routes/              Fastify 路由（chat/models/memory/tts/deps/vm...）
│   ├── tools/               TS 内置工具（12 组：file/code/sys/web/browser/adb/image/media/pdf/data/tts/mem）
│   ├── web/                 前端 TS（对话/记忆/技能市场/模型配置/心跳/语音）
│   ├── scripts/tts_gen.py   edge-tts 合成脚本
│   └── data/presets.ts      内置模型预设（agnes 默认）
├── index.html               Web 前端入口
├── style.css                样式
├── sandbox.py               Python 沙箱（子进程引擎）
├── pdf_tools.py             PDF 工具（pypdf）
├── tts_tools.py             TTS 工具（edge-tts + ffmpeg）
├── data_tools.py            数据工具（CSV/SQLite）
├── package.json             npm 依赖（fastify/tsx/typescript）
├── tsconfig.json            TypeScript 配置
├── Dockerfile / docker-compose.yml
├── .memdir/                 共享记忆文件夹
│   └── snapshots/           记忆快照
└── .skills/                 手动 Skill
```

---

## 更新日志

### 2026-09-12 启动链路修订

- **修复**：Dockerfile 基线由 `python:3.10-slim`（CMD 指向 TS 迁移时已删除的 `frontend.py`）改为 `node:20-bookworm-slim`，镜像内 `npm ci` → `npm run build` → `node dist/server.js`，并内置 Python3 / ffmpeg / Chromium 与基于 `/health` 的健康检查
- **修复**：`docker-compose.yml` 增补 `.data` 持久化卷（模型 Key 落盘目录），环境变量注释更正为 `XS_API_KEY`
- **加固**：`.dockerignore` 排除 `.data`、`.github_token`、`.gitee_token`、`*.tgz`、`dist`，避免密钥与旧产物打进镜像
- **文档**：README 启动章节重写为「源码启动（已实测）/ Docker / npm 打包」三条路径，补充环境要求表、首次配置、端口与环境变量表、启动类常见问题

### v0.0.0.5 (2026-08-30)

- **迁移**：核心逻辑全量 Python → TypeScript（Fastify + tsx）
- **新增**：记忆系统加固（原子写入、写前备份、软删除回收区、自动注入上下文）
- **新增**：agnes AI 密钥接入（agnes-2.0-flash 默认 / 2.5-flash 灰度）
- **新增**：TTS 语音合成 + 前端麦克风语音输入
- **新增**：前端密钥本地缓存 + 断线心跳自动重连
- **新增**：思考链深灰只读风（Codex 风格，不可复制）
- **新增**：SSE 流式实时思考链渲染
- **新增**：运行时环境依赖实时扫描 `/api/deps`
- **清理**：移除旧 Python 迁移残留（24 个 .py + 2 目录）

### v0.0.0.4 (2025-08-14)

- **新增**：SSE 流式实时思考链展示
- **修复**：多处中文编码乱码问题

---

## 许可证

Apache 2.0
