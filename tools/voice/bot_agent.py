"""Opt-in client for the independently running Bot; owns no host process."""
import asyncio
import json
import os
from pathlib import Path
import uuid
import urllib.request
import urllib.error
from contextlib import aclosing
from agent import failure_message
from bot_events import read_events

class BotAgent:
    def __init__(self, *, api=None, events=None):
        self.api = api or self._api
        self.events = events or self._events
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
                raise ConnectionError('无法连接 Bot 宿主，请先运行 tools/bot/run.command。') from None
        return await asyncio.to_thread(send)

    async def start(self):
        info = await self.api('/health',{})
        capabilities=info.get('replyStreaming') or {}
        self.output_mode='hybrid-stream' if (info.get('outputMode')=='hybrid-stream'
            and capabilities.get('enabled') and capabilities.get('version')==1) else 'settled-answer'
        return {**info,'outputMode':self.output_mode}

    async def _events(self,cursor):
        home=Path(os.environ.get('OPENNOVA_BOT_HOME',str(Path.home()/'.local/share/opennova/bot-spike'))).expanduser()
        token=(home/'client.token').read_text().strip()
        port=int(os.environ.get('OPENNOVA_BOT_PORT','18560'))
        async with aclosing(read_events(port,token,cursor)) as events:
            async for event in events: yield event

    @staticmethod
    def _failure(result):
        error=result.get('error') or result.get('status') or 'bot_request_failed'
        if result.get('diagnostic'):
            return ValueError(failure_message(result['diagnostic']))
        if error in ('network_error','connection_error','stream_interrupted','incomplete_agent_turn'):
            return ValueError(failure_message({'code':error,'stage':'conversation'}))
        return ValueError(error)

    @staticmethod
    def _progress(result, ident, state):
        retry=result.get('modelRetry') or {}
        if retry.get('status') in ('waiting','requesting'):
            key=(retry.get('retryId'),retry.get('retry'))
            if key!=state.get('retry'):
                state['retry']=key
                return [{'type':'status','id':ident,'phase':'retrying','retry':retry.get('retry'),'maxRetries':retry.get('maxRetries')}]
            return []
        research=result.get('research') or {}
        key=(result.get('tool'),research.get('phase'),research.get('callId'))
        if result.get('tool') and key!=state.get('tool'):
            state['tool']=key
            phase={'searching':'searching','reading':'reading','summarizing':'answering','requesting':'requesting','processing':'processing','verifying':'verifying'}.get(research.get('phase'),'working')
            if result.get('tool') not in ('web_search','web_fetch','research_sources','web_request','research_exec','research_derive'): phase='working'
            return [{'type':'status','id':ident,'phase':phase,'tool':result['tool'],'callId':research.get('callId')}]
        return []

    async def _live(self,ident):
        """Snapshots are recovery; only append an unseen, canonical speech prefix."""
        attempt=None;revision=None;text='';speech='';state={};failures=0;epoch=None
        def projection(snapshot):
            nonlocal attempt,revision,text,speech
            if not snapshot: return []
            if snapshot.get('requestId')!=ident: raise ValueError('reply_stream_request_mismatch')
            events=[]
            current=snapshot.get('attemptId');current_revision=snapshot.get('revision')
            if type(current_revision) is not int: raise ValueError('invalid_reply_revision')
            if revision is not None and current_revision<=revision: return []
            if snapshot.get('status')=='abandoned':
                if speech: raise ValueError('模型重新生成了本轮回复，已停止旧播报，请重新说话。')
                text='';attempt=current;revision=current_revision
                return [{'type':'draft','id':ident,'text':'','attemptId':current}]
            if snapshot.get('speechEligible') is not True: return []
            raw=snapshot.get('text','');safe=snapshot.get('speechText','')
            if not isinstance(raw,str) or not isinstance(safe,str) or len(raw)>16000 or len(safe)>6000:
                raise ValueError('invalid_reply_stream')
            if attempt is not None and attempt!=current:
                if speech: raise ValueError('模型重新生成了本轮回复，已停止旧播报，请重新说话。')
                text=''
            if not safe.startswith(speech): raise ValueError('模型播报内容发生变化，已停止旧播报。')
            if text and not raw.startswith(text): raise ValueError('模型流式回复发生变化，已停止本轮。')
            attempt,revision=current,current_revision
            if raw!=text:
                text=raw
                events.append({'type':'draft','id':ident,'text':raw,'attemptId':current,'timings':snapshot.get('timings',{})})
            if len(safe)>len(speech):
                delta=safe[len(speech):];speech=safe
                events.append({'type':'speech-delta','id':ident,'text':delta,'attemptId':current})
            return events

        while True:
            try:
                snapshot=await self.api('/stream-snapshot',{'id':ident})
            except (OSError,asyncio.TimeoutError):
                failures+=1
                if failures>3: raise ValueError('回答事件连接中断，请重连后查看本轮结果。') from None
                await asyncio.sleep(.1*failures)
                continue
            cursor=snapshot['cursor']
            if epoch is not None and epoch!=cursor['hostEpoch'] and speech:
                raise ValueError('Bot 已重启，已停止本轮播报；请核对结果。')
            epoch=cursor['hostEpoch']
            result=snapshot['result']
            if result.get('status') not in ('queued','running','completed'): raise self._failure(result)
            for event in projection(snapshot.get('stream')): yield event
            if result.get('status')=='completed':
                final=result.get('speechText','')
                if not isinstance(final,str) or not final.startswith(speech):
                    raise ValueError('流式播报与最终结果不一致，已停止剩余播报。')
                yield {**result,'type':'reply','id':ident,'streamedSpeech':speech}
                return
            for event in self._progress(result,ident,state): yield event
            try:
                async with aclosing(self.events(cursor)) as events:
                    async for event in events:
                        if (event.get('hostEpoch')!=cursor['hostEpoch'] or type(event.get('seq')) is not int
                                or event['seq']>cursor['seq']+1):
                            raise ConnectionError('cursor_reset')
                        if event['seq']<=cursor['seq']: continue
                        cursor={'hostEpoch':event['hostEpoch'],'seq':event['seq']};failures=0
                        if event.get('requestId')!=ident: continue
                        if event['type']=='reply.stream':
                            for item in projection(event.get('payload')): yield item
                        elif event['type']=='request.updated':
                            result=await self.api('/result',{'id':ident})
                            if result['status']=='completed':
                                final=result.get('speechText','')
                                if not isinstance(final,str) or not final.startswith(speech):
                                    raise ValueError('流式播报与最终结果不一致，已停止剩余播报。')
                                yield {**result,'type':'reply','id':ident,'streamedSpeech':speech}
                                return
                            if result['status'] not in ('queued','running'): raise self._failure(result)
                            for item in self._progress(result,ident,state): yield item
                raise ConnectionError('event_stream_closed')
            except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError):
                failures+=1
                if failures>3: raise ValueError('回答事件连接中断，请重连后查看本轮结果。') from None
                await asyncio.sleep(.1*failures)

    async def stream(self,text):
        if self.current: raise ValueError('上一轮 Bot 请求尚未结束。')
        ident=str(uuid.uuid4());self.current=self.last_request=ident
        terminal=False
        try:
            yield {'type':'request','id':ident}
            await self.api('/ask',{'id':ident,'text':text,'source':'voice'})
            if self.output_mode=='hybrid-stream':
                async with asyncio.timeout(650):
                    async with aclosing(self._live(ident)) as stream:
                        async for event in stream:
                            if event['type']=='reply': terminal=True
                            yield event
                return
            tool=None; retry_seen=None
            for _ in range(2100):
                result=await self.api('/result',{'id':ident})
                status=result['status']
                if status=='completed':
                    terminal=True
                    yield {**result,'type':'reply','id':ident}
                    return
                if status not in ('queued','running'):
                    terminal=True
                    raise self._failure(result)
                retry=result.get('modelRetry') or {}
                if retry.get('status') in ('waiting','requesting'):
                    key=(retry.get('retryId'),retry.get('retry'))
                    if key!=retry_seen:
                        retry_seen=key
                        yield {'type':'status','id':ident,'phase':'retrying','retry':retry.get('retry'),'maxRetries':retry.get('maxRetries')}
                    await asyncio.sleep(.3)
                    continue
                research=result.get('research') or {}
                key=(result.get('tool'),research.get('phase'),research.get('callId'))
                if result.get('tool') and key!=tool:
                    tool=key
                    phase={'searching':'searching','reading':'reading','summarizing':'answering','requesting':'requesting','processing':'processing','verifying':'verifying'}.get(research.get('phase'),'working')
                    if result.get('tool') not in ('web_search','web_fetch','research_sources','web_request','research_exec','research_derive'): phase='working'
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
