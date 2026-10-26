"""Cancellable HTTP/tempo subprocess; no microphone or output device ownership."""
import asyncio
import json
from pathlib import Path
import sys
import time
from agent import stop_process

async def synthesize(text, url, speed=None, metrics=None, *, provider='studio', voice=None):
    process=await asyncio.create_subprocess_exec(sys.executable,str(Path(__file__).with_name('playback.py')),'--pcm',
        stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,start_new_session=True)
    received=0
    try:
        process.stdin.write((json.dumps({'text':text,'url':url,'speed':speed,'play':False,
                                        'provider':provider,'voice':voice})+'\n').encode())
        await process.stdin.drain();process.stdin.close()
        while data:=await asyncio.wait_for(process.stdout.read(4096),120):
            received+=len(data)
            if received>120*48000: raise ValueError('TTS 音频超过上限。')
            yield data
        await asyncio.wait_for(process.wait(),10)
        raw=await process.stderr.read(16000)
        try: result=json.loads(raw)
        except ValueError: result={}
        if process.returncode or not received or received%2 or result.get('type')!='played':
            message = result.get('message') if result.get('code') == 'DoubaoTTSError' else None
            raise ValueError((message or '语音合成中断') + '；文字仍可查看。')
        if metrics is not None: metrics.update(result)
    finally:
        await stop_process(process)
        if metrics is not None:
            metrics['client_process_closed_at'] = time.monotonic()
            metrics['server_release_verified'] = False
