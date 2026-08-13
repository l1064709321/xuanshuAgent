"""
玄姝语音合成模块（edge-tts + 真人感后处理管线）
"""

import os, subprocess, asyncio, edge_tts, tempfile

_FFMPEG = os.path.expanduser("~/.local/bin/ffmpeg")

# 玄姝默认音色配置
XUANSHU_VOICE = "zh-CN-XiaoxiaoNeural"
XUANSHU_RATE = "+0%"
XUANSHU_PITCH = "+0Hz"


def tts_speak(args: dict) -> str:
    """将文本合成为玄姝语音（女声/自然/真人感后处理）"""
    text = str(args.get("text", ""))
    if not text:
        return "请提供 text 参数"

    output = args.get("output", "")
    speed = float(args.get("speed", 1.0))

    # 确定输出路径
    if output:
        out_mp3 = os.path.expanduser(output)
        if not out_mp3.endswith(".mp3"):
            out_mp3 += ".mp3"
    else:
        out_mp3 = os.path.join(tempfile.gettempdir(), f"xuanshu_tts_{abs(hash(text)) % 100000}.mp3")

    os.makedirs(os.path.dirname(out_mp3) or ".", exist_ok=True)

    try:
        # Step 1: edge-tts 原始合成
        raw = out_mp3 + ".raw.mp3"
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        async def _gen():
            comm = edge_tts.Communicate(text, voice=XUANSHU_VOICE, rate=XUANSHU_RATE, pitch=XUANSHU_PITCH)
            await comm.save(raw)

        loop.run_until_complete(_gen())
        loop.close()

        # Step 2: 真人感后处理管线
        cmd = [
            _FFMPEG, "-y", "-f", "lavfi",
            "-i", "anoisesrc=c=pink:a=0.00015:d=120",
            "-i", raw,
            "-filter_complex",
            "[1:a]aresample=44100,"
            "firequalizer=gain_entry='entry(0,0);entry(200,1);entry(500,0);entry(2000,-1.5);entry(4000,-3);entry(8000,0.5);entry(12000,2);entry(16000,2.5)',"
            "chorus=0.7:0.9:55:0.4:0.25:2,"
            "volume=4dB,"
            "acompressor=threshold=-20dB:ratio=3:attack=3:release=30:makeup=4,"
            "aecho=0.5:0.6:60:0.25,"
            "stereotools=delay=12:balance_out=0"
            "[voice];"
            f"[0:a]atrim=end=120[noise];"
            "[voice][noise]amix=inputs=2:duration=first:weights=1 0.05,"
            "alimiter=limit=0.98",
            "-c:a", "libmp3lame", "-b:a", "256k", "-ac", "2",
            out_mp3,
        ]
        subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=True)

        # Step 3: 变速（如需要）
        if speed != 1.0:
            tmp = out_mp3 + ".speed.mp3"
            cmd2 = [
                _FFMPEG, "-y", "-i", out_mp3,
                "-filter:a", f"atempo={speed}",
                "-c:a", "libmp3lame", "-b:a", "256k",
                tmp,
            ]
            subprocess.run(cmd2, capture_output=True, text=True, timeout=60, check=True)
            os.replace(tmp, out_mp3)

        # 清理原始文件
        if os.path.exists(raw):
            os.unlink(raw)

        sz = os.path.getsize(out_mp3)
        dur_cmd = [_FFMPEG.replace("ffmpeg", "ffprobe"), "-v", "quiet", "-show_entries", "format=duration",
                    "-of", "csv=p=0", out_mp3]
        dr = subprocess.run(dur_cmd, capture_output=True, text=True, timeout=10)
        dur = float(dr.stdout.strip() or 0)

        return (
            f"玄姝语音已生成: {os.path.basename(out_mp3)}\n"
            f"时长: {int(dur // 60)}分{int(dur % 60)}秒 | "
            f"大小: {sz / 1024:.0f} KB | "
            f"变速: {speed}x"
        )

    except subprocess.CalledProcessError as e:
        return f"语音合成失败: {e.stderr[-200:] if e.stderr else e}"
    except Exception as e:
        return f"语音合成失败: {e}"


def tts_list_voices(args: dict = None) -> str:
    """列出可用的语音音色"""
    lang = (args or {}).get("lang", "zh-CN")
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        voices = loop.run_until_complete(edge_tts.list_voices())
        loop.close()

        lines = [f"edge-tts 可用中文语音 (当前默认: {XUANSHU_VOICE}):"]
        for v in voices:
            if lang in v.get("Locale", ""):
                gender = v.get("Gender", "?")
                name = v.get("ShortName", "?")
                tag = "默认" if name == XUANSHU_VOICE else ""
                lines.append(f"  {name} ({gender}) {tag}")
        return "\n".join(lines)
    except Exception as e:
        return f"获取语音列表失败: {e}"
