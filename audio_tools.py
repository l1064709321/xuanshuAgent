"""
音频处理工具函数集（ffmpeg + ffprobe 实现）
供 core.py 导入并包装为 Tool 对象
"""

import os, subprocess, json, tempfile

_WS = os.path.dirname(os.path.abspath(__file__))
_FFMPEG = os.path.expanduser("~/.local/bin/ffmpeg")
_FFPROBE = os.path.expanduser("~/.local/bin/ffprobe")

SUPPORTED_FORMATS = {".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".opus", ".wma", ".ac3", ".aiff", ".ape", ".wv"}


def _safe_path(p: str) -> str:
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        p = os.path.join(_WS, p)
    return os.path.normpath(p)


def _probe(path: str) -> dict:
    """用 ffprobe 提取音频元信息"""
    cmd = [_FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        return {}
    return json.loads(r.stdout)


def _fmt_duration(sec: float) -> str:
    """秒转 mm:ss 或 hh:mm:ss"""
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def audio_info(args: dict) -> str:
    """获取音频元信息（时长/采样率/声道/比特率/格式等）"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    try:
        data = _probe(path)
        fmt = data.get("format", {})
        astreams = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
        if not astreams:
            return "未检测到音频流"

        as_ = astreams[0]
        dur = float(fmt.get("duration", 0))
        lines = [
            f"文件: {os.path.basename(path)}",
            f"格式: {fmt.get('format_name', '?').upper()}",
            f"时长: {_fmt_duration(dur)} ({dur:.2f}s)",
            f"文件大小: {int(fmt.get('size', 0)) / 1024:.1f} KB",
        ]
        if fmt.get("bit_rate"):
            lines.append(f"总比特率: {int(fmt['bit_rate']) // 1000} kbps")

        info_items = [
            ("编码", as_.get("codec_name", "?")),
            ("采样率", f"{as_.get('sample_rate', '?')} Hz"),
            ("声道", f"{as_.get('channels', '?')}"),
            ("声道布局", as_.get("channel_layout", "?")),
        ]
        if as_.get("bit_rate"):
            info_items.append(("音频比特率", f"{int(as_['bit_rate']) // 1000} kbps"))
        if as_.get("bits_per_raw_sample"):
            info_items.append(("位深", f"{as_['bits_per_raw_sample']} bit"))

        for label, val in info_items:
            if val and val != "?":
                lines.append(f"{label}: {val}")

        # 标签/元数据（title, artist, album 等）
        tags = fmt.get("tags", {})
        for key in ("title", "artist", "album", "genre", "date"):
            if key in tags:
                lines.append(f"{key}: {tags[key]}")

        return "\n".join(lines)
    except Exception as e:
        return f"读取音频信息失败: {e}"


def audio_convert(args: dict) -> str:
    """音频格式转换"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    fmt = args.get("format", "").lower().lstrip(".")
    if not fmt:
        return "请提供目标格式 format (如 mp3/wav/ogg/flac/m4a/aac)"

    bitrate = args.get("bitrate", "")  # 如 "192k" "320k"
    sample_rate = args.get("sample_rate", "")  # 如 "44100" "48000"
    output = args.get("output", "")
    out_path = _safe_path(output) if output else _safe_path(os.path.splitext(path)[0] + "." + fmt)

    try:
        cmd = [_FFMPEG, "-y", "-i", path]
        if bitrate:
            cmd += ["-b:a", bitrate]
        if sample_rate:
            cmd += ["-ar", str(sample_rate)]
        # 格式特定参数
        if fmt == "mp3":
            cmd += ["-codec:a", "libmp3lame"]
        elif fmt == "aac" or fmt == "m4a":
            cmd += ["-codec:a", "aac"]
        elif fmt == "ogg":
            cmd += ["-codec:a", "libvorbis"]
        cmd += [out_path]

        subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=True)
        old_sz = os.path.getsize(path) / 1024
        new_sz = os.path.getsize(out_path) / 1024
        return f"已转换: {os.path.basename(path)} → {os.path.basename(out_path)}\n{old_sz:.1f}KB → {new_sz:.1f}KB ({fmt.upper()})"
    except subprocess.CalledProcessError as e:
        return f"格式转换失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"格式转换失败: {e}"


def audio_trim(args: dict) -> str:
    """裁剪音频片段（按起止时间）"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    start = args.get("start", "0")       # 起始时间，如 "00:30" 或 "30"
    end = args.get("end", "")            # 结束时间，如 "01:30"
    duration = args.get("duration", "")  # 时长（与 end 二选一），如 "30"

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
        # 获取时长
        data = _probe(out_path)
        dur = float(data.get("format", {}).get("duration", 0))
        return f"已裁剪: {os.path.basename(path)} → {os.path.basename(out_path)}\n片段时长: {_fmt_duration(dur)}"
    except subprocess.CalledProcessError as e:
        # -c copy 可能因非关键帧失败，降级为重新编码
        try:
            cmd = [_FFMPEG, "-y", "-i", path, "-ss", str(start)]
            if end:
                cmd += ["-to", str(end)]
            elif duration:
                cmd += ["-t", str(duration)]
            cmd += [out_path]
            subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=True)
            data = _probe(out_path)
            dur = float(data.get("format", {}).get("duration", 0))
            return f"已裁剪（重新编码）: {os.path.basename(path)} → {os.path.basename(out_path)}\n片段时长: {_fmt_duration(dur)}"
        except Exception as e2:
            return f"裁剪失败: {e2}"
    except Exception as e:
        return f"裁剪失败: {e}"


def audio_merge(args: dict) -> str:
    """合并多个音频文件（依次拼接）"""
    paths = args.get("paths", [])
    if not paths or len(paths) < 2:
        return "请提供至少 2 个音频文件路径 paths=[...]"

    safe_paths = [_safe_path(p) for p in paths]
    for p in safe_paths:
        if not os.path.exists(p):
            return f"文件不存在: {p}"

    output = args.get("output", "")
    out_path = _safe_path(output) if output else _safe_path(os.path.splitext(safe_paths[0])[0] + "_merged" + os.path.splitext(safe_paths[0])[1])

    try:
        # 用 ffmpeg concat demuxer
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
            for p in safe_paths:
                f.write(f"file '{p}'\n")
            list_file = f.name

        cmd = [_FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", list_file, "-c", "copy", out_path]
        subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=True)
        os.unlink(list_file)

        data = _probe(out_path)
        dur = float(data.get("format", {}).get("duration", 0))
        return f"已合并 {len(paths)} 个文件 → {os.path.basename(out_path)}\n总时长: {_fmt_duration(dur)}"
    except subprocess.CalledProcessError as e:
        return f"合并失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"合并失败: {e}"


def audio_extract(args: dict) -> str:
    """从视频文件中提取音频"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    fmt = args.get("format", "mp3").lower().lstrip(".")
    bitrate = args.get("bitrate", "192k")
    output = args.get("output", "")
    out_path = _safe_path(output) if output else _safe_path(os.path.splitext(path)[0] + "_audio." + fmt)

    try:
        cmd = [_FFMPEG, "-y", "-i", path, "-vn", "-b:a", bitrate]
        if fmt == "mp3":
            cmd += ["-codec:a", "libmp3lame"]
        cmd += [out_path]

        subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=True)
        data = _probe(out_path)
        dur = float(data.get("format", {}).get("duration", 0))
        return f"已提取音频: {os.path.basename(path)} → {os.path.basename(out_path)}\n时长: {_fmt_duration(dur)}"
    except subprocess.CalledProcessError as e:
        return f"提取音频失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"提取音频失败: {e}"


def audio_speed(args: dict) -> str:
    """变速播放（不改变音调）"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    speed = float(args.get("speed", 1.0))  # 0.5=半速, 2.0=双倍速
    if not 0.25 <= speed <= 4.0:
        return "速度倍率需在 0.25 ~ 4.0 之间"

    output = args.get("output", "")
    ext = os.path.splitext(path)[1]
    out_path = _safe_path(output) if output else _safe_path(os.path.splitext(path)[0] + f"_speed_{speed}x" + ext)

    try:
        cmd = [_FFMPEG, "-y", "-i", path, "-filter:a", f"atempo={speed}", out_path]
        subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=True)
        return f"已变速 {speed}x → {os.path.basename(out_path)}"
    except subprocess.CalledProcessError as e:
        return f"变速失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"变速失败: {e}"


def audio_normalize(args: dict) -> str:
    """音量标准化"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    level = float(args.get("level", -14.0))  # LUFS 目标，默认 -14
    output = args.get("output", "")
    ext = os.path.splitext(path)[1]
    out_path = _safe_path(output) if output else _safe_path(os.path.splitext(path)[0] + "_norm" + ext)

    try:
        # loudnorm 两遍法: 第一遍分析，第二遍应用
        cmd_analyze = [_FFMPEG, "-y", "-i", path, "-af", f"loudnorm=I={level}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]
        r = subprocess.run(cmd_analyze, capture_output=True, text=True, timeout=120)
        # 从 stderr 中提取 JSON
        stderr = r.stderr
        json_start = stderr.find("{")
        json_end = stderr.rfind("}") + 1
        if json_start >= 0 and json_end > json_start:
            loud_data = json.loads(stderr[json_start:json_end])
            cmd_apply = [_FFMPEG, "-y", "-i", path, "-af",
                         f"loudnorm=I={level}:TP=-1.5:LRA=11:measured_I={loud_data['input_i']}:measured_TP={loud_data['input_tp']}:measured_LRA={loud_data['input_lra']}:measured_thresh={loud_data['input_thresh']}:offset={loud_data['target_offset']}",
                         out_path]
        else:
            # loudnorm 失败，降级为简单音量调节
            cmd_apply = [_FFMPEG, "-y", "-i", path, "-af", "volume=1.0", out_path]

        subprocess.run(cmd_apply, capture_output=True, text=True, timeout=300, check=True)
        return f"已标准化: {os.path.basename(path)} → {os.path.basename(out_path)}"
    except subprocess.CalledProcessError as e:
        return f"标准化失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"标准化失败: {e}"


def audio_fade(args: dict) -> str:
    """淡入/淡出效果"""
    path = _safe_path(args["path"])
    if not os.path.exists(path):
        return f"文件不存在: {args['path']}"

    fade_in = float(args.get("fade_in", 0))   # 淡入秒数
    fade_out = float(args.get("fade_out", 0))  # 淡出秒数

    if fade_in == 0 and fade_out == 0:
        return "请提供 fade_in（淡入秒数）或 fade_out（淡出秒数）"

    output = args.get("output", "")
    ext = os.path.splitext(path)[1]
    out_path = _safe_path(output) if output else _safe_path(os.path.splitext(path)[0] + "_fade" + ext)

    try:
        filters = []
        if fade_in > 0:
            filters.append(f"afade=t=in:d={fade_in}")
        if fade_out > 0:
            # 需要获取总时长来计算淡出起始点
            data = _probe(path)
            dur = float(data.get("format", {}).get("duration", 0))
            fade_start = max(0, dur - fade_out)
            filters.append(f"afade=t=out:st={fade_start}:d={fade_out}")

        filter_str = ",".join(filters)
        cmd = [_FFMPEG, "-y", "-i", path, "-af", filter_str, out_path]
        subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=True)

        parts = []
        if fade_in > 0:
            parts.append(f"淡入 {fade_in}s")
        if fade_out > 0:
            parts.append(f"淡出 {fade_out}s")
        return f"已应用 {' + '.join(parts)} → {os.path.basename(out_path)}"
    except subprocess.CalledProcessError as e:
        return f"淡入淡出失败: {e.stderr[-300:] if e.stderr else e}"
    except Exception as e:
        return f"淡入淡出失败: {e}"
