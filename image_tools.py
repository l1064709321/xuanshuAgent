"""
图像处理工具函数集（Pillow 实现）
供 core.py 导入并包装为 Tool 对象
"""

import os
from PIL import Image, ImageFilter

_WS = os.path.dirname(os.path.abspath(__file__))

SUPPORTED_FORMATS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".ico"}


def _safe_path(p: str) -> str:
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        p = os.path.join(_WS, p)
    return os.path.normpath(p)


def _resolve_ext(path: str, fmt: str = "") -> str:
    """根据 fmt 参数调整文件扩展名"""
    if not fmt:
        return path
    base, _ = os.path.splitext(path)
    ext = f".{fmt.lower().lstrip('.')}"
    return base + ext


def image_info(args: dict) -> str:
    """获取图像元信息"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"
    try:
        img = Image.open(path)
        info = {
            "文件": os.path.basename(path),
            "尺寸": f"{img.width} x {img.height}",
            "模式": img.mode,
            "格式": img.format,
            "文件大小": f"{os.path.getsize(path) / 1024:.1f} KB",
        }
        # EXIF 摘要
        exif = img.getexif()
        if exif:
            for tag_id in (271, 272, 306, 36867, 36868):  # Make, Model, DateTime, DateTimeOriginal, DateTimeDigitized
                tag_name = {271: "设备制造商", 272: "设备型号", 306: "拍摄时间",
                            36867: "原始日期", 36868: "数字化日期"}.get(tag_id, str(tag_id))
                val = exif.get(tag_id)
                if val:
                    info[tag_name] = str(val).rstrip("\x00")
        return "\n".join(f"{k}: {v}" for k, v in info.items())
    except Exception as e:
        return f"读取图像信息失败: {e}"


def image_compress(args: dict) -> str:
    """压缩图像（通过质量或目标大小）"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"
    quality = int(args.get("quality", 85))  # 1-100
    max_size_kb = int(args.get("max_size_kb", 0)) or None
    output = _safe_path(args.get("output", "")) or None
    fmt = args.get("format", "")  # 输出格式，默认保持原格式

    try:
        img = Image.open(path)
        converted = False
        if img.mode in ("RGBA", "P"):
            if fmt and fmt.lower() in ("jpg", "jpeg"):
                img = img.convert("RGB")
                converted = True

        out_path = output or _safe_path(os.path.splitext(path)[0] + "_compressed" + os.path.splitext(path)[1])
        out_path = _resolve_ext(out_path, fmt)

        if max_size_kb:
            # 二分逼近目标大小
            lo, hi = 1, 100
            best = None
            for _ in range(12):
                mid = (lo + hi) // 2
                buf = os.path.join(os.path.dirname(out_path), ".img_tmp_preview.jpg")
                if fmt and fmt.lower() in ("png",):
                    img.save(buf, format=fmt.upper(), optimize=True)
                else:
                    img.save(buf, format="JPEG" if not fmt or fmt.lower() in ("jpg", "jpeg") else fmt.upper(),
                             quality=mid, optimize=True)
                sz = os.path.getsize(buf) / 1024
                if sz <= max_size_kb:
                    best = (mid, buf)
                    lo = mid + 1
                else:
                    hi = mid - 1
                if lo > hi:
                    break

            if best:
                if best[1] != out_path:
                    os.rename(best[1], out_path)
                return f"已压缩: {os.path.basename(path)} → {os.path.basename(out_path)}\n原始: {os.path.getsize(path)/1024:.1f}KB → 压缩后: {os.path.getsize(out_path)/1024:.1f}KB (quality={best[0]}, 目标≤{max_size_kb}KB)"
            else:
                os.remove(buf) if os.path.exists(buf) else None
                return f"无法压缩到 {max_size_kb}KB 以内，最低可到 {os.path.getsize(buf)/1024:.1f}KB" if os.path.exists(buf) else "压缩失败"
        else:
            save_kwargs = {"optimize": True}
            if fmt and fmt.lower() not in ("png", "bmp"):
                save_kwargs["quality"] = quality
            fmt_str = fmt.upper() if fmt else (img.format or "JPEG")
            img.save(out_path, format=fmt_str, **save_kwargs)
            return f"已压缩: {os.path.basename(path)} → {os.path.basename(out_path)}\n原始: {os.path.getsize(path)/1024:.1f}KB → 压缩后: {os.path.getsize(out_path)/1024:.1f}KB (quality={quality})"
    except Exception as e:
        return f"压缩图像失败: {e}"


def image_crop(args: dict) -> str:
    """裁剪图像"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    try:
        img = Image.open(path)
        w, h = img.width, img.height

        # 支持两种裁剪方式：像素坐标(left,upper,right,lower) 或 百分比(left%,upper%,right%,lower%)
        if "percent" in args:
            p = args["percent"]  # [left%, upper%, right%, lower%]
            left = int(w * (p[0] if isinstance(p, list) else 0) / 100)
            upper = int(h * (p[1] if isinstance(p, list) and len(p) > 1 else 0) / 100)
            right = int(w * (p[2] if isinstance(p, list) and len(p) > 2 else 100) / 100)
            lower = int(h * (p[3] if isinstance(p, list) and len(p) > 3 else 100) / 100)
        else:
            box = args.get("box")  # [left, upper, right, lower]
            if not box:
                return "请提供 box=[left,upper,right,lower] 或 percent=[l%,u%,r%,l%]"
            left, upper, right, lower = box

        cropped = img.crop((left, upper, right, lower))
        output = _safe_path(args.get("output", "")) or _safe_path(
            os.path.splitext(path)[0] + "_crop" + os.path.splitext(path)[1])
        os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
        cropped.save(output)
        return f"已裁剪 {w}x{h} → {cropped.width}x{cropped.height}\n保存到: {os.path.basename(output)}"
    except Exception as e:
        return f"裁剪图像失败: {e}"


def image_resize(args: dict) -> str:
    """缩放图像"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    try:
        img = Image.open(path)

        # 支持三种缩放方式：指定宽高 / 指定宽度（等比） / 百分比
        width = int(args.get("width", 0)) or None
        height = int(args.get("height", 0)) or None
        percent = int(args.get("percent", 0)) or None

        if percent:
            new_w = int(img.width * percent / 100)
            new_h = int(img.height * percent / 100)
        elif width and height:
            new_w, new_h = width, height
        elif width:
            ratio = width / img.width
            new_w, new_h = width, int(img.height * ratio)
        elif height:
            ratio = height / img.height
            new_w, new_h = int(img.width * ratio), height
        else:
            return "请提供 width/height/percent 之一"

        resized = img.resize((new_w, new_h), Image.LANCZOS)
        output = _safe_path(args.get("output", "")) or _safe_path(
            os.path.splitext(path)[0] + f"_resized_{new_w}x{new_h}" + os.path.splitext(path)[1])
        os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
        resized.save(output)
        return f"已缩放 {img.width}x{img.height} → {new_w}x{new_h}\n保存到: {os.path.basename(output)}"
    except Exception as e:
        return f"缩放图像失败: {e}"


def image_convert(args: dict) -> str:
    """图像格式转换"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    fmt = args.get("format", "").lower().lstrip(".")
    if not fmt:
        return "请提供目标格式 format (如 png/jpg/webp/bmp/gif)"

    output = _safe_path(args.get("output", "")) or _safe_path(
        os.path.splitext(path)[0] + "." + fmt)

    try:
        img = Image.open(path)
        if fmt in ("jpg", "jpeg") and img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        elif fmt == "png" and img.mode == "P":
            pass  # P 模式可直接转 PNG
        os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
        img.save(output, format=fmt.upper() if fmt != "jpg" else "JPEG")
        return f"已转换: {os.path.basename(path)} → {os.path.basename(output)} ({fmt.upper()})"
    except Exception as e:
        return f"格式转换失败: {e}"


def image_rotate(args: dict) -> str:
    """旋转图像"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    angle = float(args.get("angle", 90))
    expand = bool(args.get("expand", True))  # 是否扩展画布

    output = _safe_path(args.get("output", "")) or _safe_path(
        os.path.splitext(path)[0] + f"_rotated_{int(angle)}" + os.path.splitext(path)[1])

    try:
        img = Image.open(path)
        rotated = img.rotate(angle, expand=expand, resample=Image.BICUBIC)
        os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
        rotated.save(output)
        return f"已旋转 {angle}° → {os.path.basename(output)}"
    except Exception as e:
        return f"旋转图像失败: {e}"


def image_thumbnail(args: dict) -> str:
    """生成缩略图"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    size = args.get("size", 256)  # 默认 256，可以是 (w,h) 或 单值即正方形
    if isinstance(size, list):
        size = tuple(size)
    elif isinstance(size, int):
        size = (size, size)

    output = _safe_path(args.get("output", "")) or _safe_path(
        os.path.splitext(path)[0] + f"_thumb_{size[0]}x{size[1]}" + os.path.splitext(path)[1])

    try:
        img = Image.open(path)
        img.thumbnail(size, Image.LANCZOS)
        os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
        img.save(output)
        return f"已生成缩略图 {img.width}x{img.height} → {os.path.basename(output)}"
    except Exception as e:
        return f"生成缩略图失败: {e}"


def image_watermark(args: dict) -> str:
    """添加文字水印"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    text = str(args.get("text", "Watermark"))
    position = args.get("position", "bottom-right")  # center / top-left / top-right / bottom-left / bottom-right
    font_size = int(args.get("font_size", 0)) or None
    color = str(args.get("color", "white"))
    opacity = int(args.get("opacity", 128))  # 0-255

    output = _safe_path(args.get("output", "")) or _safe_path(
        os.path.splitext(path)[0] + "_watermark" + os.path.splitext(path)[1])

    try:
        from PIL import ImageDraw, ImageFont

        img = Image.open(path).convert("RGBA")
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)

        # 字体大小自适应
        if font_size is None:
            font_size = max(12, min(img.width, img.height) // 20)

        # 尝试加载系统字体
        font = None
        font_paths = [
            "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        ]
        for fp in font_paths:
            if os.path.exists(fp):
                try:
                    font = ImageFont.truetype(fp, font_size)
                    break
                except Exception:
                    continue
        if font is None:
            font = ImageFont.load_default()

        # 位置计算
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        margin = 20
        pos_map = {
            "center": ((img.width - tw) // 2, (img.height - th) // 2),
            "top-left": (margin, margin),
            "top-right": (img.width - tw - margin, margin),
            "bottom-left": (margin, img.height - th - margin),
            "bottom-right": (img.width - tw - margin, img.height - th - margin),
        }
        xy = pos_map.get(position, pos_map["bottom-right"])

        draw.text(xy, text, font=font, fill=(255, 255, 255, opacity))
        result = Image.alpha_composite(img, overlay).convert("RGB")
        os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
        result.save(output)
        return f"已添加水印 '{text}' → {os.path.basename(output)}"
    except Exception as e:
        return f"添加水印失败: {e}"
