"""One reader owns worker stdout; cancellation remains responsive during generation."""
import asyncio
import json
import os
from pathlib import Path
import shutil
from agent import ROOT, failure_message, stop_process

class StreamingAgent:
    def __init__(self):
        self.process=None
        self.reader=None
        self.counter=0
        self.current=None
        self.ready=None
        self.error=None
        self.closed=False

    async def start(self):
        node=shutil.which(os.environ.get('OPENNOVA_NODE','node'))
        if not node: raise ValueError('找不到 Node，请通过 OPENNOVA_NODE 指定 Node 24。')
        self.ready=asyncio.get_running_loop().create_future()
        self.process=await asyncio.create_subprocess_exec(node,str(ROOT/'services/agent/stream-worker.mjs'),
            stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,limit=128*1024,start_new_session=True)
        self.reader=asyncio.create_task(self._read())
        return await asyncio.wait_for(asyncio.shield(self.ready),65)

    async def _read(self):
        try:
            while line:=await self.process.stdout.readline():
                event=json.loads(line)
                if not self.ready.done():
                    if event.get('type')=='ready': self.ready.set_result(event)
                    elif event.get('type')=='error': self.ready.set_exception(ValueError(failure_message(event)))
                    continue
                current=self.current
                if current and event.get('id')==current['id']:
                    if event.get('type') in ('reply','cancelled','error') and not current['done'].done():
                        current['done'].set_result(event)
                    current['queue'].put_nowait(event)
            raise ValueError('Agent 连接已关闭，请重新启动语音服务。')
        except asyncio.CancelledError: raise
        except Exception as error:
            self.error=error
            if not self.ready.done(): self.ready.set_exception(error)
            if self.current:
                event={'type':'error','stage':'conversation','code':'connection_error'}
                if not self.current['done'].done(): self.current['done'].set_result(event)
                # A full event queue is a failed turn, never silently dropped text.
                while self.current['queue'].full(): self.current['queue'].get_nowait()
                self.current['queue'].put_nowait(event)
            if self.process.returncode is None:
                try: self.process.terminate()
                except ProcessLookupError: pass

    async def _send(self,event):
        self.process.stdin.write((json.dumps(event,ensure_ascii=False)+'\n').encode())
        await self.process.stdin.drain()

    async def stream(self,text):
        if self.error is not None: raise ValueError('Agent 连接已关闭，请输入 /retry 重建连接。')
        if self.current is not None: raise ValueError('上一轮 Agent 尚未结束。')
        self.counter+=1
        current={'id':self.counter,'queue':asyncio.Queue(maxsize=2048),'done':asyncio.get_running_loop().create_future()}
        self.current=current
        try:
            await self._send({'type':'ask','id':current['id'],'text':text})
            while True:
                event=await asyncio.wait_for(current['queue'].get(),200)
                if event['type']=='error': raise ValueError(failure_message(event))
                yield event
                if event['type'] in ('reply','cancelled'): break
        finally:
            try:
                if not current['done'].done(): await self.cancel()
            finally:
                if self.current is current: self.current=None

    async def cancel(self):
        current=self.current
        if current and not current['done'].done():
            await self._send({'type':'cancel','id':current['id']})
            await asyncio.wait_for(asyncio.shield(current['done']),30)

    async def close(self):
        if self.closed: return
        self.closed=True
        try:
            if self.process is not None: await stop_process(self.process)
        finally:
            if self.reader:
                self.reader.cancel()
                await asyncio.gather(self.reader,return_exceptions=True)
