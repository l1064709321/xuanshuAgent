"""
数据处理工具函数集（csv/json/sqlite3 标准库实现）
供 core.py 导入并包装为 Tool 对象
"""

import os
import csv
import json
import sqlite3

_WS = os.path.dirname(os.path.abspath(__file__))


def _safe_path(p: str) -> str:
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        p = os.path.join(_WS, p)
    return os.path.normpath(p)


def csv_read(args: dict) -> str:
    """读取CSV文件，支持列过滤和行数限制"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"
    columns = args.get("columns", []) or None   # 指定列名列表
    limit = int(args.get("limit", 50))           # 最多行数
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            all_cols = reader.fieldnames or []
            rows = list(reader)

        if columns:
            cols = [c for c in columns if c in all_cols]
        else:
            cols = all_cols

        total = len(rows)
        rows = rows[:limit]
        lines = [f"{os.path.basename(path)} | {len(all_cols)}列 | 显示{len(rows)}/{total}行"]
        lines.append(" | ".join(cols))
        lines.append("-" * 60)
        for row in rows:
            lines.append(" | ".join(str(row.get(c, "")) for c in cols))

        if total > limit:
            lines.append(f"... 还有 {total - limit} 行未显示")
        return "\n".join(lines)
    except Exception as e:
        return f"读取CSV失败: {e}"


def csv_stats(args: dict) -> str:
    """CSV统计：列数、行数、每列非空计数、数值列的基本统计"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            cols = reader.fieldnames or []
            rows = list(reader)

        lines = [f"{os.path.basename(path)} | {len(cols)}列 x {len(rows)}行\n"]
        lines.append(f"{'列名':20s} {'非空':>6s} {'类型':>8s} {'最小值':>12s} {'最大值':>12s} {'平均值':>12s}")
        lines.append("-" * 72)

        for c in cols:
            vals = [row[c] for row in rows if row.get(c, "").strip() != ""]
            non_empty = len(vals)
            if non_empty == 0:
                lines.append(f"{c:20s} {0:>6d} {'empty':>8s}")
                continue

            # 尝试数值
            nums = []
            for v in vals:
                try:
                    nums.append(float(v))
                except ValueError:
                    pass

            if len(nums) == non_empty:
                lines.append(f"{c:20s} {non_empty:>6d} {'numeric':>8s} {min(nums):>12.4g} {max(nums):>12.4g} {sum(nums)/len(nums):>12.4g}")
            elif len(nums) > 0:
                lines.append(f"{c:20s} {non_empty:>6d} {'mixed':>8s} {'-':>12s} {'-':>12s} {'-':>12s}")
            else:
                lines.append(f"{c:20s} {non_empty:>6d} {'string':>8s} {'-':>12s} {'-':>12s} {'-':>12s}")

        return "\n".join(lines)
    except Exception as e:
        return f"统计CSV失败: {e}"


def json_read(args: dict) -> str:
    """读取JSON文件，支持键路径查询"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"
    key = args.get("key", "") or None   # "a.b[0].c" 形式
    limit = int(args.get("limit", 100))
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        if key:
            # 支持点号和数组索引：data.items[0].name
            parts = key.replace("[", ".").replace("]", "").split(".")
            cur = data
            for p in parts:
                if p == "":
                    continue
                if isinstance(cur, list):
                    try:
                        cur = cur[int(p)]
                    except (ValueError, IndexError):
                        return f"键路径 {key} 在 {p} 处失败: 索引超出范围"
                elif isinstance(cur, dict):
                    if p not in cur:
                        return f"键路径 {key} 在 {p} 处失败: 键不存在"
                    cur = cur[p]
                else:
                    return f"键路径 {key} 在 {p} 处失败: 当前值为 {type(cur).__name__}"
            data = cur

        text = json.dumps(data, ensure_ascii=False, indent=2)
        if len(text) > limit * 100:
            text = text[:limit * 100] + "\n... [截断]"
        return text
    except json.JSONDecodeError as e:
        return f"JSON解析失败: {e}"
    except Exception as e:
        return f"读取JSON失败: {e}"


def sqlite_query(args: dict) -> str:
    """在SQLite数据库上执行只读查询"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"数据库不存在: {args['path']}"
    query = args["query"].strip()
    if not query.upper().startswith("SELECT") and not query.upper().startswith("PRAGMA") and not query.upper().startswith("EXPLAIN"):
        # 安全检查：非 SELECT/PRAGMA/EXPLAIN 语句需要 display=True 显式授权
        if not args.get("display", False):
            return f"非只读SQL被拦截: {query}\n如需执行，请设置 display=true"
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        cursor = conn.cursor()
        cursor.execute(query)

        if query.upper().startswith("SELECT") or query.upper().startswith("PRAGMA"):
            cols = [d[0] for d in cursor.description] if cursor.description else []
            rows = cursor.fetchall()
            limit = int(args.get("limit", 50))
            rows = rows[:limit]
            lines = [f"{os.path.basename(path)} | 返回{len(rows)}行"]
            lines.append(" | ".join(cols) if cols else "(无列名)")
            lines.append("-" * 60)
            for row in rows:
                lines.append(" | ".join(str(v) for v in row))
            return "\n".join(lines)
        else:
            conn.close()
            conn = sqlite3.connect(path)
            conn.execute(query)
            conn.commit()
            conn.close()
            return f"已执行: {query[:80]}"
    except Exception as e:
        return f"SQLite查询失败: {e}"
    finally:
        try:
            conn.close()
        except Exception:
            pass


def sqlite_tables(args: dict) -> str:
    """列出SQLite数据库中的所有表及其结构"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"数据库不存在: {args['path']}"
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        tables = [r[0] for r in cursor.fetchall()]
        if not tables:
            conn.close()
            return "数据库中没有表"

        lines = [f"{os.path.basename(path)} | {len(tables)} 张表\n"]
        for t in tables:
            cursor.execute(f"SELECT COUNT(*) FROM [{t}]")
            row_count = cursor.fetchone()[0]
            cursor.execute(f"PRAGMA table_info([{t}])")
            cols = cursor.fetchall()
            col_info = ", ".join(f"{c[1]}({c[2]})" for c in cols)
            lines.append(f"  {t}: {row_count}行 | {col_info}")
        conn.close()
        return "\n".join(lines)
    except Exception as e:
        return f"列出表失败: {e}"
