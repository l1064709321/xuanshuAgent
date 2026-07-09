---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 0e1b95e548a05d7a5680b10b9bcd3bb3_51694caf7b2c11f18401525400bff409
    ReservedCode1: t5sGGzBnGFDhR8ye+uVQc3B6QKB2CmSQ+4Csn5FJFTFiixYq/6oHvwALDwwUdxZEGIdkqt8YcHeBZ/pUNUMCBSHp1m1GJJUufRoA8i81viZWWerUkbijAmAYpKlXA57Fxg7AJcVEcBL0MooEEosTDg8N0DhImLNCYGwFDLU7LHd2aOw98irFdWgNmT0=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 0e1b95e548a05d7a5680b10b9bcd3bb3_51694caf7b2c11f18401525400bff409
    ReservedCode2: t5sGGzBnGFDhR8ye+uVQc3B6QKB2CmSQ+4Csn5FJFTFiixYq/6oHvwALDwwUdxZEGIdkqt8YcHeBZ/pUNUMCBSHp1m1GJJUufRoA8i81viZWWerUkbijAmAYpKlXA57Fxg7AJcVEcBL0MooEEosTDg8N0DhImLNCYGwFDLU7LHd2aOw98irFdWgNmT0=
---

# 玄姝 (Xuanshu) — 多 Agent 协作系统 v0.0.0.2

> 玄姝多 Agent 系统：父 Bot 路由 + 协调者模式 + 子 Bot 独立记忆 + 思考链可视化 + Skill 学习闭环

## 核心能力

| 模块 | 功能 |
|------|------|
| **父 Bot 路由** | 根据用户意图自动分派给搜索/代码/文件三类子 Agent |
| **协调者模式** | Research → Synthesis → Implementation → Verification 四阶段工作流 |
| **思考链可视化** | SSE 流式传输 LLM 思考过程，前端折叠面板展示工具调用链 |
| **Skill 学习闭环** | 复杂任务（≥5 轮工具调用）完成后自动提炼 Skill，TF-IDF 向量化检索复用 |
| **Skills REST API** | 手动创建/列出/读取/删除 Skill，支持按 Agent 隔离管理 |
| **向量化记忆** | SkillStore: TF-IDF + 余弦相似度检索，sqlite 持久化存储 |
| **Continue/Fresh 决策** | 基于上下文重叠度自动判断复用会话还是新开会话 |
| **Fork 子代理** | 继承父上下文平行执行，无需重复初始化 |
| **独立记忆** | 每个子 Agent 拥有独立记忆空间，支持快照导出/导入 |
| **自校验** | 代码类 Agent 执行后自动验证结果 |

## 双前端

| 前端 | 路径 | 特点 |
|------|------|------|
| **主前端** | `index.html` + `style.css` | 全功能控制台，模型管理、记忆快照、Agent 配置 |
| **玄姝 v2** | `xuanshu_v2/` | Ink-Editorial 设计体系，轻量对话界面 + 思考链面板 |

## 环境要求

- Python 3.11+
- Linux / macOS

## 安装

```bash
git clone https://github.com/l1064709321/xuanshuAgent.git
cd xuanshuAgent
pip install flask openai httpx
```

## 启动

```bash
python frontend.py
# 浏览器打开 http://localhost:8900
```

在界面选择模型并填入 API Key（设为 `local` 使用本地模拟）。

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | Web 前端界面 |
| `/chat` | POST | 对话（非流式），返回 `{reply, thinking}` |
| `/api/chat/stream` | POST | 流式对话（SSE），实时输出文本 + 思考链事件 |
| `/coordinator-mode` | POST | 切换协调者模式 |
| `/models` | GET/POST | 查看/添加模型配置 |
| `/models/<key>` | DELETE | 删除自定义模型 |
| `/set-key` | POST | 设置 API Key |
| `/skills/list` | POST | 列出 Skills |
| `/skills/read` | POST | 读取单个 Skill |
| `/skills/create` | POST | 手动创建 Skill |
| `/skills/delete` | POST | 删除 Skill |
| `/snapshots/export` | POST | 导出所有子 Agent 记忆快照 |
| `/snapshots/import` | POST | 导入记忆快照 |
| `/memory/*` | GET/POST | 记忆文件夹 CRUD |

## 项目结构

```
xuanshuAgent/
├── frontend.py          # Flask 后端 + REST API + SSE 流式
├── core.py              # 父 Bot + 协调者 + 子 Agent + SkillStore 向量化
├── models.py            # 模型池定义
├── memory.py            # 子 Agent 独立记忆 + 快照
├── web_search.py        # 联网搜索
├── logger.py            # 日志模块
├── main.py              # 命令行入口
├── index.html           # 主前端界面
├── style.css            # 主前端样式
├── xuanshu_v2/          # v2 前端（Ink-Editorial）
│   ├── index.html
│   └── style.css
├── .memdir/             # 子 Agent 持久记忆
│   ├── skills/          # 自动学习 Skill
│   └── snapshots/       # 记忆快照
└── .skills/             # 手动 Skills（REST API 管理）
```

## 思考链数据流

```
LLM thinking → _run_child 截取 → thinking_log 列表
  → chat_stream SSE yield {type:"thinking", tool:"...", thought:"...", round:N}
  → 前端 read() 解析 JSON → typing 指示器更新 → [DONE] 后 addBubble
  → <details class="thinking-chain"> 折叠面板渲染
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
*（内容由AI生成，仅供参考）*
