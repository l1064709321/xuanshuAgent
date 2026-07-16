"""
工作流执行器 —— 按步骤依次执行动作链，并将中间结果传入下一步。
"""
import json, os, time
from typing import Optional

from workflow import find_matching_workflows, list_workflows

# ---------- 步骤执行上下文 ----------
class StepContext:
    """在步骤间传递数据"""
    def __init__(self, user_message: str):
        self.user_message = user_message
        self.data = {}         # 键值对，模板变量填充
        self.results = []      # 每步执行结果记录

    def set(self, key: str, value):
        self.data[key] = value

    def get(self, key: str) -> str:
        return self.data.get(key, "")

    def add_result(self, step_idx: int, action: str, status: str, output: str):
        self.results.append({
            "step": step_idx + 1,
            "action": action,
            "status": status,   # ok / error / skipped
            "output": output[:500],
        })

    def render(self, template: str) -> str:
        """用当前上下文替换模板变量 {key}"""
        for k, v in self.data.items():
            template = template.replace(f"{{{k}}}", str(v))
        # 内置变量
        template = template.replace("{user_message}", self.user_message)
        return template


# ---------- 执行器入口 ----------
async def execute_workflows(user_message: str, tools: dict) -> Optional[str]:
    """
    对用户消息匹配所有工作流，依次执行。
    tools 字典需至少提供: web_search, ai_summary（callable）
    返回拼接后的执行结果文本，无匹配时返回 None。
    """
    wfs = find_matching_workflows(user_message)
    if not wfs:
        return None

    outputs = []
    for wf in wfs:
        ctx = StepContext(user_message)
        steps = wf.get("steps", [])

        for i, step in enumerate(steps):
            action = step.get("action", "")
            params = {k: ctx.render(str(v)) for k, v in step.get("params", {}).items()}

            if action == "web_search":
                search_fn = tools.get("web_search")
                if search_fn:
                    try:
                        result = await search_fn(params.get("query", ctx.user_message))
                        ctx.set("search_result", result)
                        ctx.add_result(i, action, "ok", result[:300])
                    except Exception as e:
                        ctx.add_result(i, action, "error", str(e))

            elif action == "ai_summary":
                ai_fn = tools.get("ai_summary")
                if ai_fn:
                    try:
                        prompt = params.get("prompt", "")
                        source = params.get("source", "search_result")
                        content = ctx.get(source) or ctx.user_message
                        full_prompt = f"{prompt}\n\n--- 以下为原始内容 ---\n{content}"
                        result = await ai_fn(full_prompt)
                        ctx.set("ai_output", result)
                        ctx.add_result(i, action, "ok", result[:300])
                    except Exception as e:
                        ctx.add_result(i, action, "error", str(e))

            elif action == "write_file":
                write_fn = tools.get("write_file")
                if write_fn:
                    try:
                        filename = params.get("filename", "output.txt")
                        content = params.get("content", ctx.get("ai_output"))
                        filepath = await write_fn(filename, content)
                        ctx.set("file_path", filepath)
                        ctx.add_result(i, action, "ok", filepath)
                    except Exception as e:
                        ctx.add_result(i, action, "error", str(e))

            elif action == "notify":
                notify_fn = tools.get("notify")
                if notify_fn:
                    try:
                        msg = params.get("message", "")
                        await notify_fn(msg)
                        ctx.add_result(i, action, "ok", "通知已发送")
                    except Exception as e:
                        ctx.add_result(i, action, "error", str(e))

            else:
                ctx.add_result(i, action, "skipped", f"未知动作: {action}")

        # 汇总输出
        lines = [f"📋 规则「{wf['name']}」执行结果："]
        for r in ctx.results:
            icon = "✅" if r["status"] == "ok" else "❌" if r["status"] == "error" else "⏭️"
            lines.append(f"  {icon} 步骤{r['step']} ({r['action']}): {r['output'][:100]}")
        outputs.append("\n".join(lines))

    return "\n\n".join(outputs)
