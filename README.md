# 玄姝 (Xuanshu) — 多 Agent 协作系统 v0.1.1

> 玄姝多 Agent 系统：父 Bot 路由 + 协调者模式 + 子 Bot 独立记忆 + Fork 子代理

## 核心能力

| 模块 | 功能 |
|------|------|
| **父 Bot 路由** | 根据用户意图自动分派给搜索/代码/文件三类子 Agent |
| **协调者模式** | Research → Synthesis → Implementation → Verification 四阶段工作流 |
| **Continue/Fresh 决策** | 基于上下文重叠度自动判断复用会话还是新开会话 |
| **Fork 子代理** | 继承父上下文平行执行，无需重复初始化 |
| **独立记忆** | 每个子 Agent 拥有独立记忆空间，支持快照导出/导入 |
| **自校验** | 代码类 Agent 执行后自动验证结果 |

## 支持的模型

内置 39 个主流大模型，包括 GPT-4o、Claude 3.5 Sonnet、Gemini 2.0、Qwen2.5、DeepSeek-V3 等。通过 `models.py` 可自定义添加。

## 环境要求

- Python 3.8+
- Linux / macOS / Windows（WSL）

## 安装

```bash
# 1. 克隆仓库
git clone https://gh-proxy.com/github.com/l1064709321/xuanshuAgent.git
cd xuanshuAgent

# 2. 安装依赖
pip install flask openai
```

## 启动

### 方式一：Web 服务（推荐）

```bash
python frontend.py
# 浏览器打开 http://localhost:8900
```

在界面填入 API Key（或设为 `local` 使用本地模拟），即可开始对话。

### 方式二：命令行

```bash
python main.py --model gpt-4o --key sk-xxxx
# 或使用本地模拟模式
python main.py --quiet
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | Web 前端界面 |
| `/chat` | POST | 发送消息 `{"message":"..."}` |
| `/coordinator-mode` | POST | 切换协调者模式 `{"enabled":true/false}` |
| `/models` | GET/POST | 查看/添加模型配置 |
| `/models/<key>` | DELETE | 删除自定义模型 |
| `/set-key` | POST | 设置 API Key `{"key":"sk-xxx"}` |
| `/snapshots/export` | POST | 导出所有子 Agent 记忆快照 |
| `/snapshots/import` | POST | 导入记忆快照 |
| `/browse` | POST | 浏览文件目录 `{"path":"..."}` |
| `/file/read` | POST | 读取文件内容 `{"path":"..."}` |
| `/memory/list` | GET | 列出共享记忆文件 |
| `/memory/read` | POST | 读取记忆文件 `{"path":"..."}` |
| `/memory/write` | POST | 写入记忆文件 `{"path":"...","content":"..."}` |
| `/memory/delete` | POST | 删除记忆文件 `{"path":"..."}` |

## 项目结构

```
xuanshuAgent/
├── frontend.py      # Flask 后端 + API + 静态文件托管
├── core.py          # 父 Bot + 协调者 + 子 Agent 系统核心
├── models.py        # 39 模型池定义
├── memory.py        # 子 Agent 独立记忆 + 快照
├── web_search.py    # 联网搜索 + 域名信誉过滤
├── logger.py        # 日志模块
├── main.py          # 命令行入口（含 /search 命令）
├── push.py          # Git 推送辅助脚本
├── demo_cloud_agent.py  # 云端 Agent 演示
├── index.html       # Web 前端界面
└── start.sh         # 快速启动脚本
```

## 协调者模式流程

```
用户输入
  → Research: 搜索Agent 收集信息
  → Synthesis: 父Bot 综合分析生成方案
  → Implementation: 代码Agent 或 文件Agent 执行
  → Verification: 自校验验证结果
  → 返回最终回复
```
