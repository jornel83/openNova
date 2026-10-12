"""Continuous conversation state: input, generation and playback have separate lifetimes."""
import asyncio
from contextlib import aclosing
import time
from segments import SentenceBuffer
from tts_stream import synthesize as synthesize_pcm


def effective(text):
    return isinstance(text, str) and any(char.isalnum() for char in text)


class Conversation:
    def __init__(self, agent, audio, tts_url, *, synthesize=synthesize_pcm, log=print, reset_input=None, render_text=None):
        self.agent, self.audio, self.tts_url = agent, audio, tts_url
        self.synthesize, self.log, self.reset_input = synthesize, log, reset_input
        self.render_text = render_text or log
        self.active, self.muted, self.quit = True, False, False
        self.intent_active = True
        self.epoch = self.generation = 0
        self.inputs = {}
        self.response = None
        self.response_record = None
        self.tasks = set()
        self.agent_lock = asyncio.Lock()
        self.records = []
        self.interrupted = False
        self.unsubmitted = ''

    async def invalidate(self, reason):
        self.generation += 1
        response, record = self.response, self.response_record
        self.response = self.response_record = None
        if response and not response.done():
            if record and record['status'] == 'running':
                record.update(status='interrupted', interruption=reason, stopped_at=time.monotonic())
                self.interrupted = True
                if not record.get('admitted'): self.unsubmitted = record['input']
                record['segments_with_played_chunks'] = sorted(getattr(self.audio, 'played_segments', set()))
            if not response.cancelling(): response.cancel()
        # Stop locally before waiting for model/HTTP cleanup, which runs in the cancelled task.
        await self.audio.clear(self.generation)
        if record: record['local_clear_ack_at'] = time.monotonic()

    async def handle(self, event):
        if event.get('epoch') != self.epoch or self.muted or not self.active: return
        kind = event['type']
        if kind == 'zero_input':
            self.log('连续 5 秒为全零信号，请检查麦克风、合盖状态和权限。')
            return
        if kind == 'notice': self.log(event['text']); return
        ident = event['id']
        if kind == 'start':
            self.inputs[ident] = {'final':None,'finished':False,'confirmed':False,'text':''}
            if self.response and not self.response.done():
                if self.response_record:
                    self.response_record['candidate_started_at'] = event.get('time',time.monotonic())
                await self.audio.pause()
                if self.response_record:
                    self.response_record['pause_ack_at'] = time.monotonic()
                self.log('检测到人声，已暂停播报，正在确认。')
            return
        turn = self.inputs.get(ident)
        if turn is None: return
        if kind in ('partial','final'):
            turn['text'] = event.get('text','')  # ASR full-result revisions replace, never append.
            if effective(turn['text']) and not turn['confirmed']:
                turn['confirmed'] = True
                if self.response and not self.response.done():
                    await self.invalidate('speech')
                    self.log('已打断上一段回复，继续听你说。')
        if kind == 'final':
            turn.update(finished=True, final=turn['text'] if effective(turn['text']) else None)
        elif kind == 'failed':
            turn.update(finished=True, final=None)
            self.log(event.get('error','本轮识别未完成，请重新说话。'))
        elif kind == 'end':
            turn['ended_at'] = event.get('time', time.monotonic())
        if self.inputs and all(turn['finished'] for turn in self.inputs.values()):
            texts = [turn['final'] for _,turn in sorted(self.inputs.items()) if turn['final']]
            ended = max((turn.get('ended_at',time.monotonic()) for turn in self.inputs.values()))
            self.inputs.clear()
            if texts:
                await self.ask('\n'.join(texts), ended)
            elif self.response and not self.response.done():
                await self.audio.resume()
                self.log('未确认有效发言，恢复上一段播报。')

    async def ask(self, text, ended_at=None):
        await self.invalidate('replacement')
        original = text
        if self.unsubmitted:
            text = self.unsubmitted+'\n'+text
            self.unsubmitted = ''
        if self.interrupted:
            text = '[语音状态：上一段回复的播报已被打断，用户可能未听完；无需从头重播。]\n'+text
            self.interrupted = False
        record = {'input':original,'text':'','status':'running','generation':self.generation,
                  'submitted_at':time.monotonic(),'input_ended_at':ended_at,'segments':[], 'admitted':False}
        self.records.append(record)
        self.response_record = record
        task = asyncio.create_task(self._respond(text, record))
        self.response = task
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        self.log('你：'+original)
        self.log('正在思考，麦克风继续聆听。')

    async def _respond(self, text, record):
        generation = record['generation']
        queue = asyncio.Queue(maxsize=8)
        async def produce():
            buffer = SentenceBuffer()
            attempt = None
            seq = 0
            async with self.agent_lock:
                if generation != self.generation: return
                record['admitted'] = True
                stream = self.agent.stream(text)
                try:
                    async for event in stream:
                        if generation != self.generation: return
                        if event['type'] == 'delta':
                            current_attempt = event.get('attemptId')
                            if attempt and attempt != current_attempt:
                                raise ValueError('模型重新生成了本轮回复，已停止旧播报，请重新说话。')
                            attempt = current_attempt
                            if 'first_delta_at' not in record:
                                record['first_delta_at'] = time.monotonic()
                                self.render_text('OpenNova：')
                            record['text'] += event['text']
                            if len(record['text']) > 6000: raise ValueError('模型回复过长，已停止本轮。')
                            self.render_text(event['text'])
                            for part in buffer.feed(event['text']):
                                seq += 1
                                await queue.put((seq,part))
                        elif event['type'] == 'reply':
                            self.render_text('\n')
                            record['agent_complete_at'] = time.monotonic()
                            record['agent'] = event
                            # No silent fallback to whole-result replay if the live bridge is incomplete.
                            if event['text'] != record['text']:
                                raise ValueError('模型流式回复与最终结果不一致，已停止剩余播报。')
                            for part in buffer.finish():
                                seq += 1
                                await queue.put((seq,part))
                        elif event['type'] == 'cancelled':
                            raise ValueError('本轮模型回复已取消。')
                except Exception as error:
                    await fail_output(error)
                    raise
                finally:
                    await stream.aclose()
            if 'agent_complete_at' not in record: raise ValueError('模型回复未完整结束。')
            await queue.put(None)

        async def speak():
            while item := await queue.get():
                seq, part = item
                if generation != self.generation: return
                segment = {'id':seq,'text':part,'requested_at':time.monotonic()}
                record['segments'].append(segment)
                pending = b''
                async with aclosing(self.synthesize(part,self.tts_url,speed=1.5,metrics=segment)) as stream:
                    async for pcm in stream:
                        if generation != self.generation: return
                        pending += pcm
                        size = len(pending)//2*2
                        if not size: continue
                        # Native chunks stay below the 8192-byte IPC limit.
                        for offset in range(0,size,4096):
                            chunk = pending[offset:min(offset+4096,size)]
                            record.setdefault('first_pcm_at', time.monotonic())
                            if not await self.audio.write(chunk,generation,seq): return
                            record.setdefault('first_enqueue_at', time.monotonic())
                        pending = pending[size:]
                if pending: raise ValueError('合成音频尾部不完整。')
                segment['http_closed_at'] = time.monotonic()
            await self.audio.drained(generation)
            record['playback_drained_at'] = time.monotonic()

        async def fail_output(error):
            if record['status'] != 'running': return
            record.update(status='failed',error='reply_interrupted',failed_at=time.monotonic())
            if generation == self.generation:
                self.generation += 1
                try: await self.audio.clear(self.generation)
                except Exception: pass
                record['local_clear_ack_at'] = time.monotonic()
                while isinstance(error, BaseExceptionGroup): error = error.exceptions[0]
                if record['text']: self.render_text('\n')
                self.log('回复中断：'+str(error)+' 已显示的文字保留，可继续说话。')

        async def guarded(work):
            try: await work()
            except Exception as error:
                await fail_output(error)
                raise

        try:
            async with asyncio.TaskGroup() as group:
                group.create_task(guarded(produce))
                group.create_task(guarded(speak))
            if generation == self.generation:
                record.update(status='complete', completed_at=time.monotonic())
                self.log('回复完成，正在聆听。')
        except asyncio.CancelledError:
            if record['text']: self.render_text('\n')
            record.setdefault('interruption','cancelled')
            if record['status'] == 'running': record['status'] = 'interrupted'
            record['local_pipeline_closed_at'] = time.monotonic()
            raise
        except Exception as error:
            await fail_output(error)
        finally:
            record['pipeline_closed_at'] = time.monotonic()

    async def control(self, command):
        if command == '/stop':
            await self.invalidate('stop')
            self.unsubmitted = ''
            self.log('已停止当前回复，继续聆听。')
        elif command in ('/mute','/unmute','/end','/start'):
            self.epoch += 1
            self.inputs.clear()
            if self.reset_input: self.reset_input(self.epoch)
            if command == '/end':
                self.intent_active = self.active = False
                await self.invalidate('end')
                self.unsubmitted = ''
            elif command == '/start': self.intent_active, self.active, self.muted = True, True, False
            else: self.muted = command == '/mute'
            await self.audio.capture(self.active and not self.muted,self.epoch)
            if self.response and not self.response.done(): await self.audio.resume()
            self.log('正在聆听。' if self.active and not self.muted else '已静音。' if self.active else '交流已结束；输入 /start 重新开始。')
        elif command == '/quit':
            self.quit = True
            self.intent_active = False
            await self.invalidate('quit')
        else: self.log('可用操作：/stop /mute /unmute /end /start /retry /quit（输入后回车）。')

    async def wait_idle(self):
        if self.tasks: await asyncio.gather(*tuple(self.tasks),return_exceptions=True)

    async def restore_audio(self):
        """Replacing a device respects control commands issued during startup."""
        self.epoch += 1
        self.inputs.clear()
        if self.reset_input: self.reset_input(self.epoch)
        self.active = self.intent_active and not self.quit
        await self.audio.clear(self.generation)
        await self.audio.capture(self.active and not self.muted,self.epoch)
        self.log('正在聆听。' if self.active and not self.muted else '已静音。' if self.active else '交流已结束；输入 /start 重新开始。')

    async def close(self):
        try: await self.invalidate('close')
        finally:
            for task in self.tasks:
                if not task.cancelling(): task.cancel()
            await self.wait_idle()
