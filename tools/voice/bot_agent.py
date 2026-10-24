"""Opt-in client for the independently running Bot; owns no host process."""
import asyncio
import json
import os
from pathlib import Path
import uuid
import urllib.request
import urllib.error

class BotAgent:
    def __init__(self, *, api=None):
        self.api = api or self._api
        self.output_mode = 'settled-answer'
        self.process = None
        self.error = None
        self.current = None
        self.closed = False
        self.last_request = None

    async def _api(self, path, body, *, timeout=20):
        def send():
            home = Path(os.environ.get('OPENNOVA_BOT_HOME', str(Path.home()/'.local/share/opennova/bot-spike'))).expanduser()
            token = (home/'client.token').read_text().strip()
            port = int(os.environ.get('OPENNOVA_BOT_PORT','18560'))
            req = urllib.request.Request(f'http://127.0.0.1:{port}'+path,
                data=json.dumps(body).encode(), headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                with opener.open(req,timeout=timeout) as response: return json.load(response)
            except urllib.error.HTTPError as error:
                try: message=json.load(error).get('error','bot_request_failed')
                except Exception: message='bot_request_failed'
                raise ValueError(message) from None
            except (OSError,urllib.error.URLError):
                raise ValueError('无法连接 Bot 宿主，请先运行 tools/bot/run.command。') from None
        return await asyncio.to_thread(send)

    async def start(self):
        info = await self.api('/health',{})
        return {**info,'outputMode':'settled-answer'}

    async def stream(self,text):
        if self.current: raise ValueError('上一轮 Bot 请求尚未结束。')
        ident=str(uuid.uuid4());self.current=self.last_request=ident
        terminal=False
        try:
            yield {'type':'request','id':ident}
            await self.api('/ask',{'id':ident,'text':text,'source':'voice'})
            tool=None
            for _ in range(2100):
                result=await self.api('/result',{'id':ident})
                status=result['status']
                if status=='completed':
                    terminal=True
                    yield {**result,'type':'reply','id':ident}
                    return
                if status not in ('queued','running'):
                    terminal=True
                    raise ValueError(result.get('error') or status)
                research=result.get('research') or {}
                key=(result.get('tool'),research.get('phase'),research.get('callId'))
                if result.get('tool') and key!=tool:
                    tool=key
                    phase={'searching':'searching','reading':'reading','summarizing':'answering'}.get(research.get('phase'),'working')
                    if result.get('tool') not in ('web_search','web_fetch','research_sources'): phase='working'
                    yield {'type':'status','id':ident,'phase':phase,'tool':result['tool'],'callId':research.get('callId')}
                await asyncio.sleep(.3)
            raise ValueError('Bot 等待超时；可用 /result 查询已提交请求。')
        finally:
            # Cancel only this foreground reply. Independent tasks have different IDs.
            try:
                if not terminal: await self.cancel()
            finally:
                if self.current==ident:self.current=None

    async def cancel(self):
        if self.current: await self.api('/voice/cancel-request',{'id':self.current})

    async def control(self,command):
        parts=command.split(maxsplit=1);name=parts[0];ident=parts[1].strip() if len(parts)>1 else None
        routes={'/operations':'/operations','/pending':'/approvals','/approve':'/approve','/reject':'/reject','/tasks':'/tasks','/cancel-task':'/cancel-task','/memory':'/memory','/result':'/result'}
        if name not in routes:return None
        if name=='/result':ident=ident or self.last_request
        if name in ('/approve','/reject','/cancel-task','/result') and not ident:raise ValueError('请提供对应编号。')
        return await self.api(routes[name],{'id':ident} if ident else {})

    async def close(self):
        self.closed=True
