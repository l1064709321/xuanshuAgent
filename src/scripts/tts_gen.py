#!/usr/bin/env python3
"""玄姝 TTS 合成脚本（edge-tts）— 供 /api/tts 路由调用
用法: python3 tts_gen.py --text "内容" --out /path/out.mp3 [--speed 1.0] [--voice zh-CN-XiaoxiaoNeural]
"""
import argparse, asyncio, os, sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    args = ap.parse_args()

    text = args.text.strip()
    if not text:
        print("text 不能为空", file=sys.stderr)
        return 1

    # edge-tts rate 转换：speed=1.0 -> +0%；1.2 -> +20%；0.8 -> -20%
    if args.speed <= 0:
        args.speed = 1.0
    delta = int(round((args.speed - 1.0) * 100))
    rate = f"{'+' if delta >= 0 else ''}{delta}%"

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)

    try:
        import edge_tts

        async def _gen():
            comm = edge_tts.Communicate(text, voice=args.voice, rate=rate)
            await comm.save(args.out)

        asyncio.run(_gen())
    except Exception as e:  # noqa: BLE001
        print(f"TTS 合成失败: {e}", file=sys.stderr)
        return 1

    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        print("TTS 输出为空", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
