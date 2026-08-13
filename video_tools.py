"""
视频处理工具函数集（ffmpeg 实现）
供 core.py 导入并包装为 Tool 对象
"""

import os, subprocess, json, tempfile, re

_WS = os.path.dirname(os.path.abspath(__file__))
_FFMPEG = os.path.expanduser("~/.local/bin/ffmpeg")
_FFPROBE = os.path.expanduser("~/.local/bin/ffprobe")

SUPPORTED_FORMATS = {".mp4", ".mkv", ".webm", ".avi", ".mov", ".flv", ".wmv", ".m4v", ".ts", ".3gp"}


def _safe_path(p: str) -> str:
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        p = os.path.join(_WS, p)
    return os.path.normpath(p)


def _probe(path: str) -> dict:
    cmd = [_FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        return {}
    return json.loads(r.stdout)


def _fmt_duration(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _fmt_size(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / 1024 / 1024:.1f} MB"
    return f"{n / 1024:.1f} KB"


def video_info(args: dict) -> str:
    """获取视频元信息（时长/分辨率/编码/帧率/码率）"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    try:
        data = _probe(path)
        fmt = data.get("format", {})
        vstreams = [s for s in data.get("streams", []) if s.get("codec_type") == "video"]
        astreams = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]

        dur = float(fmt.get("duration", 0))
        lines = [
            f"文件: {os.path.basename(path)}",
            f"格式: {fmt.get('format_name', '?').upper()}",
            f"时长: {_fmt_duration(dur)} ({dur:.2f}s)",
            f"文件大小: {_fmt_size(int(fmt.get('size', 0)))}",
        ]

        if vstreams:
            vs = vstreams[0]
            lines.append("── 视频流 ──")
            lines.append(f"编码: {vs.get('codec_name', '?')}")
            lines.append(f"分辨率: {vs.get('width', '?')}x{vs.get('height', '?')}")
            fps_str = "?"
            if "r_frame_rate" in vs:
                parts = vs["r_frame_rate"].split("/")
                if len(parts) == 2 and float(parts[1]) > 0:
                    fps_str = f"{float(parts[0]) / float(parts[1]):.2f}"
            lines.append(f"帧率: {fps_str} fps")
            if vs.get("bit_rate"):
                lines.append(f"视频码率: {int(vs['bit_rate']) // 1000} kbps")
            if vs.get("pix_fmt"):
                lines.append(f"像素格式: {vs['pix_fmt']}")

        if astreams:
            as_ = astreams[0]
            lines.append("── 音频流 ──")
            lines.append(f"编码: {as_.get('codec_name', '?')}")
            if as_.get("sample_rate"):
                lines.append(f"采样率: {as_['sample_rate']} Hz")
            if as_.get("channels"):
                lines.append(f"声道: {as_['channels']}")
            if as_.get("bit_rate"):
                lines.append(f"音频码率: {int(as_['bit_rate']) // 1000} kbps")

        return "\n".join(lines)
    except Exception as e:
        return f"读取视频信息失败: {e}"


def video_convert(args: dict) -> str:
    """视频格式转换"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    fmt = args.get("format", "mp4").lower().lstrip(".")
    codec = args.get("codec", "")  # h264/h265/vp9
    crf = args.get("crf", 23)       # 质量 0-51，越小越好，默认23
    bitrate = args.get("bitrate", "")  # 如 "2M"
    output = args.get("output", "")
    out_path = _safe_path(output) if output else _safe_path(os.path.splitext(path)[0] + "_converted." + fmt)

    try:
        cmd = [_FFMPEG, "-y", "-i", path]
        if codec:
            cmd += ["-c:v", codec]
        else:
            # 默认编码器
            if fmt in ("mp4", "mov"):
                cmd += ["-c:v", "libx264"]
            elif fmt == "webm":
                cmd += ["-c:v", "libvpx-vp9"]
            elif fmt == "gif":
                pass
        if crf and fmt != "gif":
            cmd += ["-crf", str(crf)]
        if bitrate:
            cmd += ["-b:v", bitrate]
        cmd += ["-c:a", "aac", out_path]

        subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=True)
        old_sz = os.path.getsize(path)
        new_sz = os.path.getsize(out_path)
        return f"已转换: {os.path.basename(path)} → {os.path.basename(out_path)}\n{_fmt_size(old_sz)} → {_fmt_size(new_sz)} ({fmt.upper()})"
    except subprocess.CalledProcessError as e:
        return f"格式转换失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"格式转换失败: {e}"


def video_trim(args: dict) -> str:
    """裁剪视频片段（按起止时间）"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    start = args.get("start", "0")
    end = args.get("end", "")
    duration = args.get("duration", "")
    if not end and not duration:
        return "请提供 end（结束时间）或 duration（裁剪时长）"

    output = args.get("output", "")
    ext = os.path.splitext(path)[1]
    out_path = _safe_path(output) if output else _safe_path(os.path.splitext(path)[0] + "_trim" + ext)

    try:
        cmd = [_FFMPEG, "-y", "-i", path, "-ss", str(start)]
        if end:
            cmd += ["-to", str(end)]
        elif duration:
            cmd += ["-t", str(duration)]
        cmd += ["-c", "copy", out_path]

        subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=True)
        data = _probe(out_path)
        dur = float(data.get("format", {}).get("duration", 0))
        return f"已裁剪: {os.path.basename(path)} → {os.path.basename(out_path)}\n片段时长: {_fmt_duration(dur)}"
    except subprocess.CalledProcessError:
        # -c copy 失败，重新编码
        try:
            cmd = [_FFMPEG, "-y", "-i", path, "-ss", str(start)]
            if end:
                cmd += ["-to", str(end)]
            elif duration:
                cmd += ["-t", str(duration)]
            cmd += [out_path]
            subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=True)
            data = _probe(out_path)
            dur = float(data.get("format", {}).get("duration", 0))
            return f"已裁剪（重新编码）: {os.path.basename(path)} → {os.path.basename(out_path)}\n片段时长: {_fmt_duration(dur)}"
        except Exception as e2:
            return f"裁剪失败: {e2}"
    except Exception as e:
        return f"裁剪失败: {e}"


def video_merge(args: dict) -> str:
    """合并多个视频文件（依次拼接）"""
    paths = args.get("paths", [])
    if not paths or len(paths) < 2:
        return "请提供至少 2 个视频文件路径 paths=[...]"

    safe_paths = [_safe_path(p) for p in paths]
    for p in safe_paths:
        if not os.path.exists(p):
            return f"文件不存在: {p}"

    output = args.get("output", "")
    out_path = _safe_path(output) if output else _safe_path(
        os.path.splitext(safe_paths[0])[0] + "_merged" + os.path.splitext(safe_paths[0])[1])

    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
            for p in safe_paths:
                f.write(f"file '{p}'\n")
            list_file = f.name

        cmd = [_FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", list_file, "-c", "copy", out_path]
        subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=True)
        os.unlink(list_file)

        data = _probe(out_path)
        dur = float(data.get("format", {}).get("duration", 0))
        return f"已合并 {len(paths)} 个文件 → {os.path.basename(out_path)}\n总时长: {_fmt_duration(dur)}"
    except subprocess.CalledProcessError as e:
        return f"合并失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"合并失败: {e}"


def video_compress(args: dict) -> str:
    """压缩视频（CRF质量/目标文件大小）"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    crf = int(args.get("crf", 28))          # 默认 28（较高压缩）
    max_size_mb = int(args.get("max_size_mb", 0)) or None
    resolution = args.get("resolution", "")   # 如 "1280x720"
    fps = args.get("fps", "")                 # 如 "30"
    codec = args.get("codec", "libx264")

    output = args.get("output", "")
    ext = os.path.splitext(path)[1]
    out_path = _safe_path(output) if output else _safe_path(os.path.splitext(path)[0] + "_compressed" + ext)

    try:
        cmd = [_FFMPEG, "-y", "-i", path, "-c:v", codec, "-crf", str(crf)]
        if resolution:
            cmd += ["-vf", f"scale={resolution}"]
        if fps:
            cmd += ["-r", fps]
        cmd += ["-c:a", "aac", "-b:a", "96k", out_path]

        if max_size_mb:
            # 两遍法：先粗略估计，再微调
            # 第一遍用 crf 试探
            tmp = out_path + ".tmp.mp4"
            subprocess.run(cmd[:-1] + [tmp], capture_output=True, text=True, timeout=600, check=True)
            tmp_sz = os.path.getsize(tmp)
            target_sz = max_size_mb * 1024 * 1024

            if tmp_sz <= target_sz:
                os.rename(tmp, out_path)
                return f"已压缩: {os.path.basename(path)} → {os.path.basename(out_path)}\n{_fmt_size(os.path.getsize(path))} → {_fmt_size(os.path.getsize(out_path))} (CRF={crf})"

            # 用 bitrate 精确控制
            dur = float(_probe(path).get("format", {}).get("duration", 1))
            target_br = int((target_sz * 8) / dur) - 128000  # 减去音频 bitrate
            target_br = max(100000, target_br)  # 最低 100k

            cmd2 = [_FFMPEG, "-y", "-i", path, "-c:v", codec, "-b:v", f"{target_br}"]
            if resolution:
                cmd2 += ["-vf", f"scale={resolution}"]
            if fps:
                cmd2 += ["-r", fps]
            cmd2 += ["-c:a", "aac", "-b:a", "96k", out_path]

            subprocess.run(cmd2, capture_output=True, text=True, timeout=600, check=True)
            os.unlink(tmp)
        else:
            subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=True)

        old_sz = os.path.getsize(path)
        new_sz = os.path.getsize(out_path)
        return f"已压缩: {os.path.basename(path)} → {os.path.basename(out_path)}\n{_fmt_size(old_sz)} → {_fmt_size(new_sz)} (CRF={crf}, 压缩比 {new_sz / old_sz:.0%})"
    except subprocess.CalledProcessError as e:
        return f"压缩失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"压缩失败: {e}"


def video_resize(args: dict) -> str:
    """调整视频分辨率"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    resolution = args.get("resolution", "")  # 如 "1920x1080" 或 "hd" / "fhd"
    res_map = {"hd": "1280x720", "fhd": "1920x1080", "4k": "3840x2160", "sd": "720x480"}
    resolution = res_map.get(resolution.lower(), resolution)

    if not resolution or "x" not in resolution:
        return "请提供 resolution（如 1920x1080 / hd / fhd / sd）"

    output = args.get("output", "")
    ext = os.path.splitext(path)[1]
    out_path = _safe_path(output) if output else _safe_path(
        os.path.splitext(path)[0] + f"_{resolution}" + ext)

    try:
        cmd = [_FFMPEG, "-y", "-i", path, "-vf", f"scale={resolution}", "-c:a", "copy", out_path]
        subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=True)
        return f"已缩放: {os.path.basename(path)} → {os.path.basename(out_path)} ({resolution})"
    except subprocess.CalledProcessError as e:
        return f"缩放失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"缩放失败: {e}"


def video_fps(args: dict) -> str:
    """调整视频帧率"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    fps = args.get("fps", 30)
    try:
        fps = int(fps)
    except ValueError:
        return f"无效帧率: {fps}"

    output = args.get("output", "")
    ext = os.path.splitext(path)[1]
    out_path = _safe_path(output) if output else _safe_path(os.path.splitext(path)[0] + f"_fps{fps}" + ext)

    try:
        cmd = [_FFMPEG, "-y", "-i", path, "-r", str(fps), "-c:a", "copy", out_path]
        subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=True)
        return f"已调整帧率: {os.path.basename(path)} → {os.path.basename(out_path)} ({fps} fps)"
    except subprocess.CalledProcessError as e:
        return f"调整帧率失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"调整帧率失败: {e}"


def video_snapshot(args: dict) -> str:
    """视频截图（按时间点或自动采样）"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    at_time = args.get("at", "")          # 时间点如 "00:05"
    count = int(args.get("count", 1))     # 截图数量（自动间隔采样）
    output = args.get("output", "")
    width = args.get("width", 0) or None  # 输出宽度

    ext = os.path.splitext(path)[1]
    base = _safe_path(output) if output else _safe_path(os.path.splitext(path)[0] + "_snap")

    try:
        if at_time:
            out_path = base + ".jpg"
            cmd = [_FFMPEG, "-y", "-ss", str(at_time), "-i", path, "-vframes", "1", "-q:v", "2"]
            if width:
                cmd += ["-vf", f"scale={width}:-1"]
            cmd += [out_path]
            subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True)
            return f"已截图 ({at_time}): {os.path.basename(out_path)}"
        else:
            # 自动间隔采样
            dur = float(_probe(path).get("format", {}).get("duration", 0))
            interval = dur / (count + 1)
            results = []
            for i in range(1, count + 1):
                t = interval * i
                out_path = f"{base}_{i:02d}.jpg"
                cmd = [_FFMPEG, "-y", "-ss", str(t), "-i", path, "-vframes", "1", "-q:v", "2"]
                if width:
                    cmd += ["-vf", f"scale={width}:-1"]
                cmd += [out_path]
                subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True)
                results.append(os.path.basename(out_path))
            return f"已截图 {count} 张: {', '.join(results)}"
    except subprocess.CalledProcessError as e:
        return f"截图失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"截图失败: {e}"


def video_to_gif(args: dict) -> str:
    """视频转 GIF 动图"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    start = args.get("start", "0")
    duration = args.get("duration", "5")   # 默认5秒
    fps = int(args.get("fps", 10))          # GIF 帧率，默认10
    width = int(args.get("width", 320))     # 输出宽度
    output = args.get("output", "")
    out_path = _safe_path(output) if output else _safe_path(os.path.splitext(path)[0] + ".gif")

    try:
        # 使用 palette 生成高质量 GIF
        filter_str = f"fps={fps},scale={width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"
        cmd = [_FFMPEG, "-y", "-ss", str(start), "-t", str(duration),
               "-i", path, "-filter_complex", filter_str, out_path]
        subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=True)
        new_sz = os.path.getsize(out_path)
        return f"已生成 GIF: {os.path.basename(out_path)}\n{_fmt_size(new_sz)} ({fps}fps, {duration}s)"
    except subprocess.CalledProcessError as e:
        return f"GIF 生成失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"GIF 生成失败: {e}"


def video_watermark(args: dict) -> str:
    """添加文字水印"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    text = str(args.get("text", "Watermark"))
    position = args.get("position", "br")  # tl/tr/bl/br/center
    font_size = int(args.get("font_size", 24))
    opacity = float(args.get("opacity", 0.5))
    output = args.get("output", "")
    ext = os.path.splitext(path)[1]
    out_path = _safe_path(output) if output else _safe_path(os.path.splitext(path)[0] + "_wm" + ext)

    pos_map = {
        "tl": f"x=10:y=10",
        "tr": f"x=w-tw-10:y=10",
        "bl": f"x=10:y=h-th-10",
        "br": f"x=w-tw-10:y=h-th-10",
        "center": f"x=(w-tw)/2:y=(h-th)/2",
    }
    pos_expr = pos_map.get(position, pos_map["br"])

    try:
        vf = f"drawtext=text='{text}':fontsize={font_size}:fontcolor=white@{opacity}:{pos_expr}"
        cmd = [_FFMPEG, "-y", "-i", path, "-vf", vf, "-codec:a", "copy", out_path]
        subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=True)
        return f"已添加水印: {os.path.basename(path)} → {os.path.basename(out_path)}"
    except subprocess.CalledProcessError as e:
        return f"水印失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"水印失败: {e}"
