"""
PDF 处理工具函数集（pypdf 实现）
供 core.py 导入并包装为 Tool 对象
"""

import os
import io

try:
    from pypdf import PdfReader, PdfWriter
except ImportError:
    PdfReader = None
    PdfWriter = None

_WS = os.path.dirname(os.path.abspath(__file__))


def _safe_path(p: str) -> str:
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        p = os.path.join(_WS, p)
    return os.path.normpath(p)


def pdf_read(args: dict) -> str:
    """读取PDF文本内容"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"
    page_start = max(1, int(args.get("page_start", 1)))
    page_end = int(args.get("page_end", 0)) or None
    try:
        reader = PdfReader(path)
        total = len(reader.pages)
        end = page_end if page_end else total
        end = min(end, total)
        parts = [f"{os.path.basename(path)} | 共{total}页 | 第{page_start}-{end}页\n"]
        for i in range(page_start - 1, end):
            text = reader.pages[i].extract_text()
            parts.append(f"--- 第{i+1}页 ---\n{text or '(空白)'}")
        return "\n".join(parts)
    except Exception as e:
        return f"读取PDF失败: {e}"


def pdf_merge(args: dict) -> str:
    """合并多个PDF"""
    paths_input = args["paths"]
    if isinstance(paths_input, str):
        paths = [_safe_path(p.strip()) for p in paths_input.split(",")]
    else:
        paths = [_safe_path(p) for p in paths_input]
    output_path = _safe_path(args["output"])
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        return f"文件不存在: {missing}"
    try:
        merger = PdfWriter()
        for p in paths:
            merger.append(p)
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        merger.write(output_path)
        merger.close()
        return f"已合并 {len(paths)} 个PDF → {args['output']}"
    except Exception as e:
        return f"合并PDF失败: {e}"


def pdf_split(args: dict) -> str:
    """拆分PDF"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"
    pages = args.get("pages", []) or []
    ranges = args.get("ranges", []) or []
    output_dir = _safe_path(args.get("output_dir", "."))
    prefix = args.get("prefix", "split")
    try:
        reader = PdfReader(path)
        total = len(reader.pages)
        os.makedirs(output_dir, exist_ok=True)
        created = []
        for p in pages:
            if p < 1 or p > total:
                continue
            writer = PdfWriter()
            writer.add_page(reader.pages[p - 1])
            fname = f"{prefix}_p{p}.pdf"
            out = os.path.join(output_dir, fname)
            writer.write(out)
            writer.close()
            created.append(fname)
        for s, e in ranges:
            s, e = max(1, s), min(total, e)
            if s > e:
                continue
            writer = PdfWriter()
            for j in range(s - 1, e):
                writer.add_page(reader.pages[j])
            fname = f"{prefix}_p{s}-{e}.pdf"
            out = os.path.join(output_dir, fname)
            writer.write(out)
            writer.close()
            created.append(fname)
        if not created:
            return "未生成任何文件，请检查页码范围"
        return f"已生成 {len(created)} 个文件到 {args.get('output_dir', '.')}:\n" + "\n".join(f"  - {c}" for c in created)
    except Exception as e:
        return f"拆分PDF失败: {e}"


def pdf_meta(args: dict) -> str:
    """提取PDF元信息"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"
    try:
        reader = PdfReader(path)
        meta = reader.metadata
        cd = getattr(meta, "creation_date", None)
        md = getattr(meta, "modification_date", None)
        info = {
            "文件": os.path.basename(path),
            "页数": len(reader.pages),
            "标题": getattr(meta, "title", None),
            "作者": getattr(meta, "author", None),
            "主题": getattr(meta, "subject", None),
            "创建者": getattr(meta, "creator", None),
            "生成工具": getattr(meta, "producer", None),
            "创建时间": str(cd) if cd else None,
            "修改时间": str(md) if md else None,
        }
        return "\n".join(f"{k}: {v or '无'}" for k, v in info.items())
    except Exception as e:
        return f"读取PDF元信息失败: {e}"


def pdf_extract_images(args: dict) -> str:
    """提取PDF中的图片"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"
    output_dir = _safe_path(args.get("output_dir", "."))
    prefix = args.get("prefix", "img")
    try:
        reader = PdfReader(path)
        os.makedirs(output_dir, exist_ok=True)
        count = 0
        for page_num, page in enumerate(reader.pages):
            for img_key in page.images:
                img = page.images[img_key]
                ext = os.path.splitext(img.name)[-1] or ".png"
                fname = f"{prefix}_p{page_num+1}_{img_key}{ext}"
                out = os.path.join(output_dir, fname)
                with open(out, "wb") as f:
                    f.write(img.data)
                count += 1
        return f"已提取 {count} 张图片到 {args.get('output_dir', '.')}"
    except Exception as e:
        return f"提取图片失败: {e}"
