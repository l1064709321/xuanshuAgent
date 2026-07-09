#!/bin/bash
# 玄姝多Agent系统 启动脚本
cd /home/marvis/Marvis/User/77A0318BB6CBFBF7DD7DE820DE597C1E/workspace/conv_19e5d3037f5_3a9b862be1cb/output/multi_agent
exec python3 main.py --model nemotron-super --key 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 "$@"
