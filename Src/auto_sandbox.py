"""
Auto Sandbox Decision Layer — Agent 自主判断是否进入沙箱
- 代码类：自动沙箱执行
- 文件类：自动沙箱预检
- 配置类：自动回滚保护
- Pre-push 验证：推送前自动跑一遍沙箱回归
"""
import os, sys, json, subprocess
from datetime import datetime
from sandbox import run_sandboxed, _SANDBOX_BASE

_WS = os.path.dirname(os.path.abspath(__file__))


class AutoSandbox:
    """Agent 自主沙箱决策器"""

    RULES = {
        "code_execution": True,      # 任何代码执行 → 自动进沙箱
        "file_write": True,          # 写入文件 → 沙箱预检
        "config_change": True,       # 配置变更 → 沙箱预检
        "git_push": True,            # Git 推送前 → 自动跑回归
        "untested_code": True,       # 未测试代码 → 强制沙箱
    }

    @staticmethod
    def should_sandbox(operation_type: str, context: dict = None) -> bool:
        """Agent 调用此方法决定是否进沙箱"""
        return AutoSandbox.RULES.get(operation_type, False)

    @staticmethod
    def test_code(code: str, test_inputs: list = None) -> dict:
        """自主测试一段代码：注入测试用例，收集结果"""
        test_wrapper = f"""
# 自动测试
import sys, traceback

tests_passed = 0
tests_total = 0

# 用户代码
{code}

# 测试用例
"""
        if test_inputs:
            for i, tc in enumerate(test_inputs):
                test_wrapper += f"""
try:
    {tc}
    tests_passed += 1
except Exception as e:
    print(f"[TEST FAIL #{i}] {{e}}", file=sys.stderr)
    traceback.print_exc()
tests_total += 1
"""
        test_wrapper += f"""
print(f"\\n[AUTO_TEST] {{tests_passed}}/{{tests_total}} passed")
"""

        result = run_sandboxed(test_wrapper, timeout=30)
        return {
            "stdout": result["stdout"],
            "stderr": result["stderr"],
            "exit_code": result["exit_code"],
            "timed_out": result.get("timed_out", False),
            "tested_at": datetime.now().isoformat(),
        }

    @staticmethod
    def pre_push_validate(project_dir: str = None) -> dict:
        """推送前自动验证：读取文件内容后做语法检查"""
        d = project_dir or _WS
        py_files = []
        for root, dirs, files in os.walk(d):
            dirs[:] = [x for x in dirs if x not in ('.git', '.sandbox', '__pycache__', '.memory', '.memdir')]
            for f in files:
                if f.endswith('.py'):
                    py_files.append(os.path.join(root, f))

        results = {"total": len(py_files), "passed": 0, "failed": [], "checked_at": datetime.now().isoformat()}
        for f in py_files:
            try:
                with open(f, 'r') as src:
                    code = src.read()
                compile(code, f, 'exec')
                results["passed"] += 1
            except SyntaxError as e:
                results["failed"].append({"file": f, "error": str(e)})
            except Exception as e:
                results["failed"].append({"file": f, "error": str(e)})
        return results

    @staticmethod
    def validate_frontend(html_path: str) -> dict:
        """验证前端 HTML 完整性"""
        result = {"path": html_path, "valid": False, "checks": {}, "checked_at": datetime.now().isoformat()}
        try:
            with open(html_path, 'r') as f:
                content = f.read()
            result["checks"] = {
                "has_doctype": content.strip().startswith('<!DOCTYPE html>'),
                "has_html_close": '</html>' in content,
                "has_body_close": '</body>' in content,
                "has_script_close": '</script>' in content,
                "no_syntax_gaps": content.count('<script') == content.count('</script>'),
                "size_kb": len(content) // 1024,
            }
            result["valid"] = all(v for k, v in result["checks"].items() if k != "size_kb")
        except Exception as e:
            result["error"] = str(e)
        return result


# 全局单例
auto_sandbox = AutoSandbox()
