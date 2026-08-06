# 技能市场（Skills Marketplace）

项目级共享技能库，所有子 Agent 冻结层自动注入。

## 技能清单

| 技能 ID | 文件 | 领域 | 摘要 |
|---------|------|------|------|
| SK-001 | `code_review.md` | 代码 | 系统化代码审查流程与检查清单 |
| SK-002 | `debugging.md` | 调试 | 分层调试策略：日志→断点→二分→隔离 |
| SK-003 | `shell_execution.md` | 运维 | Shell 命令安全执行与错误处理 |
| SK-004 | `error_handling.md` | 架构 | 错误分类/降级/重试/熔断模式 |
| SK-005 | `web_research.md` | 调研 | 多源交叉验证与信息可信度评估 |
| SK-006 | `file_operations.md` | 文件 | 批量文件操作规范与安全检查 |

## 技能格式约定

每个技能文件遵循 Markdown 格式，Agent 可直接解析执行：

```markdown
# 技能名称
## 触发条件
## 执行步骤
## 注意事项
## 示例
```

## 添加新技能

在 `skills/` 目录下新增 `.md` 文件即可，重启后自动注入所有子 Agent 冻结层。
