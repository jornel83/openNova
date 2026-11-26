"""Line-oriented terminal controls; no blocking stdin thread to leak at exit."""
import asyncio
import sys

HELP = '操作（输入后回车）：/stop 停止当前回复或播报 · /mute 关闭麦克风（仍可播报） · /unmute 开启麦克风 · /end 结束交流 · /start 开始 · /retry 重连音频 · /disable 关闭语音并释放音频设备 · /quit 退出；Ctrl+C 退出。'

async def read_controls(queue):
    reader = asyncio.StreamReader(limit=4096)
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    try:
        while line := await reader.readline():
            command = line.decode(errors='replace').strip()
            if command: await queue.put(command)
        await queue.put('/quit')
    finally:
        transport.close()
