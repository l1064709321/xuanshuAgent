# xuanshuAgent

扣子风格多Agent系统 — 父Bot路由 + 子Bot独立记忆 + 前后端分离

## 架构

```
用户输入 → 父Bot（意图路由）→ 子Bot执行 → 汇总返回
                              ├─ 搜索Agent（联网检索）
                              ├─ 代码Agent（编程调试）
                              └─ 文件Agent（文件管理）
```

## 文件结构

| 文件 | 说明 |
|------|------|
| `main.py` | 终端入口，命令行交互 |
| `core.py` | 父Bot路由 + 子Bot定义 + 对话流程 |
| `models.py` | 多模型池管理，多对多绑定 |
| `memory.py` | Agent独立记忆系统（短/中/长期） |
| `logger.py` | 日志系统 |
| `frontend.py` | Flask API后端（JSON接口） |
| `index.html` | 前端页面（独立HTML/CSS/JS） |

## 启动

```bash
python main.py
```

## 命令

| 命令 | 说明 |
|------|------|
| `/model [编号]` | 切换模型 |
| `/bind Agent 模型` | 子Agent独立绑定模型 |
| `/status` | 系统状态（含记忆统计） |
| `/agents` | 查看所有子Agent配置 |
| `/new` | 新对话 |
| `/help` | 帮助 |
