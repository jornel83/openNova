"""Continuous conversation state: input, generation and playback have separate lifetimes."""
import asyncio
from contextlib import aclosing
import time
from segments import SentenceBuffer
from tts_stream import synthesize as synthesize_pcm
from barge_in import BargeInCandidate, PAUSE_TIMEOUT


def effective(text):
    return isinstance(text, str) and any(char.isalnum() for char in text)


class Conversation:
    def __init__(self, agent, audio, tts_url, *, synthesize=synthesize_pcm, log=print, reset_input=None, render_text=None, tts_speed=1.5, on_state=None):
        self.agent, self.audio, self.tts_url = agent, audio, tts_url
        self.on_state = on_state
        self.draft = None
        self.audio_failed = False
        self.tts_speed = tts_speed
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
        self.notice_delay = 2.0
        self.paused_at = None

    def voice_state(self):
        record = self.response_record or {}
        running = record.get('status') == 'running'
        playback = getattr(self.audio,'playback','idle') if running else 'idle'
        if playback == 'idle' and running and record.get('tts_started'): playback = 'buffering'
        return dict(generation=self.generation,captureEpoch=self.epoch,
            capture='error' if self.audio_failed else 'off' if not self.active or self.quit else 'muted' if self.muted else 'listening',
            recognition='recognizing' if any(not t['finished'] for t in self.inputs.values()) else 'idle',
            playback='error' if self.audio_failed else playback,requestId=record.get('requestId'),draft=self.draft)

    def notify(self):
        if self.on_state: self.on_state(self.voice_state())

    async def handle(self, event):
        try: await self._handle(event)
        finally: self.notify()

    async def control(self, command):
        try: await self._control(command)
        finally: self.notify()

    async def invalidate(self, reason):
        self.paused_at = None
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
        if not getattr(self.audio,'closed',False):
            await self.audio.clear(self.generation)
            if record: record['local_clear_ack_at'] = time.monotonic()
        self.notify()

    def trace_candidate(self, turn, action):
        record = turn.get('record')
        if record is not None:
            trace = record.setdefault('barge_in', [])
            if len(trace) < 50:
                trace.append({'at':time.monotonic(),'action':action,
                              **turn['candidate'].acoustic})

    async def resume_candidate(self, reason):
        if self.paused_at is None: return
        self.paused_at = None
        for turn in self.inputs.values():
            if turn.get('candidate'):
                turn['candidate'].pause_expired = True
                self.trace_candidate(turn, reason)
        if self.response and not self.response.done():
            await self.audio.resume()
            self.log('未确认有效插话，恢复播报。')

    async def _handle(self, event):
        if event.get('epoch') != self.epoch or self.muted or not self.active: return
        kind = event['type']
        now = event.get('time', time.monotonic())
        if self.paused_at is not None and now-self.paused_at >= PAUSE_TIMEOUT:
            await self.resume_candidate('confirmation_timeout')
        if kind == 'tick': return
        if kind == 'zero_input':
            self.log('连续 5 秒为全零信号，请检查麦克风、合盖状态和权限。')
            return
        if kind == 'notice': self.log(event['text']); return
        ident = event['id']
        if kind == 'start':
            guarded = bool(self.response and not self.response.done())
            self.inputs[ident] = {'final':None,'finished':False,'confirmed':False,'text':'',
                'candidate':BargeInCandidate() if guarded else None,
                'generation':self.generation,'record':self.response_record if guarded else None}
            self.draft = {'text':'','utteranceId':str(ident),'requestId':None}
            if guarded:
                self.inputs[ident]['candidate'].update({**event,'time':now})
                self.trace_candidate(self.inputs[ident], 'candidate')
            return
        turn = self.inputs.get(ident)
        if turn is None: return
        candidate = turn['candidate']
        accepted = candidate.update({**event,'time':now}) if candidate else effective(event.get('text',''))
        if kind in ('partial','final'):
            turn['text'] = event.get('text','')  # ASR full-result revisions replace, never append.
            self.draft = {'text':'\n'.join(t['text'] for _,t in sorted(self.inputs.items()) if t['text']), 'utteranceId':str(ident),'requestId':None}
            if accepted and not turn['confirmed']:
                turn['confirmed'] = True
                if candidate: self.trace_candidate(turn, 'confirmed')
                if self.response and not self.response.done() and turn['generation']==self.generation:
                    await self.invalidate('speech')
                    self.log('已打断上一段回复，继续听你说。')
        if (candidate and not turn['confirmed'] and kind in ('evidence','partial')
                and candidate.can_pause and self.response and not self.response.done()
                and turn['generation']==self.generation and self.paused_at is None):
            await self.audio.pause()
            self.paused_at = time.monotonic()
            self.trace_candidate(turn, 'paused')
            self.log('检测到持续人声，暂缓播报，正在确认插话。')
        if kind == 'final':
            # Once interruption was confirmed, keep ASR revisions of that utterance.
            keep = effective(turn['text']) and (accepted or turn['confirmed'])
            turn.update(finished=True, final=turn['text'] if keep else None)
            if candidate and not keep: self.trace_candidate(turn, 'filtered_final')
        elif kind == 'failed':
            turn.update(finished=True, final=None)
            if candidate: self.trace_candidate(turn, 'asr_failed')
            if not candidate or turn['confirmed']:
                self.log(event.get('error','本轮识别未完成，请重新说话。'))
        elif kind == 'end':
            turn['ended_at'] = event.get('time', time.monotonic())
        if self.inputs and all(turn['finished'] for turn in self.inputs.values()):
            texts = [turn['final'] for _,turn in sorted(self.inputs.items()) if turn['final']]
            ended = max((turn.get('ended_at',time.monotonic()) for turn in self.inputs.values()))
            if texts:
                self.inputs.clear()
                await self.ask('\n'.join(texts), ended)
            else:
                await self.resume_candidate('unconfirmed')
                self.inputs.clear()
                self.draft = None

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
                  'submitted_at':time.monotonic(),'input_ended_at':ended_at,'segments':[], 'admitted':False,
                  'output_mode':getattr(self.agent,'output_mode','incremental'),'speech_text':'','sources':[],'tool_events':[]}
        self.records.append(record)
        self.response_record = record
        task = asyncio.create_task(self._respond(text, record))
        self.response = task
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        self.notify()
        self.log('你：'+original)
        self.log('正在思考，麦克风继续聆听。')

    async def _respond(self, text, record):
        generation = record['generation']
        queue = asyncio.Queue(maxsize=8)
        settled = record['output_mode'] == 'settled-answer'
        answer_ready = asyncio.Event()
        async def delayed_notice():
            await asyncio.sleep(self.notice_delay)
            if generation == self.generation and not answer_ready.is_set():
                await queue.put((0,'我查一下，请稍等。',True))
        async def produce():
            buffer = SentenceBuffer()
            attempt = None
            seq = 0
            notice_task = None
            async with self.agent_lock:
                if generation != self.generation: return
                record['admitted'] = True
                stream = self.agent.stream(text)
                try:
                    async for event in stream:
                        if generation != self.generation: return
                        if event['type'] == 'request':
                            record['requestId'] = event['id']
                            if self.draft: self.draft = {**self.draft,'requestId':event['id']}
                            self.notify()
                        elif event['type'] == 'status':
                            phase = event.get('phase')
                            record['tool_events'].append({'phase':phase,'step':event.get('step'),'at':time.monotonic()})
                            if phase in ('searching','reading','requesting','processing','verifying'):
                                self.log({'searching':'正在联网搜索。','reading':'正在读取资料。','requesting':'正在获取数据。','processing':'正在处理数据。','verifying':'正在核对结果。'}[phase])
                                if settled and notice_task is None: notice_task = asyncio.create_task(delayed_notice())
                        elif event['type'] == 'sources':
                            # Pending evidence is not presented as a completed answer.
                            record['sources_received_at'] = time.monotonic()
                        elif event['type'] == 'delta':
                            if settled: raise ValueError('联网模式不应提前播报未完成的模型文本。')
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
                                await queue.put((seq,part,False))
                        elif event['type'] == 'reply':
                            record['agent_complete_at'] = time.monotonic()
                            record['agent'] = event
                            answer_ready.set()
                            if settled:
                                speech = event.get('speechText')
                                if not isinstance(speech,str) or not speech.strip() or len(speech)>6000 or len(event['text'])>16000:
                                    raise ValueError('完整答案或播报内容无效。')
                                record.update(text=event['text'],speech_text=speech,sources=event.get('sources',[]))
                                self.render_text('OpenNova：'+event['text']+'\n')
                                for source in record['sources']:
                                    self.log(f"来源 {source['id']}：{source['title']} {source['url']}")
                                parts = buffer.feed(speech)+buffer.finish()
                            else:
                                self.render_text('\n')
                                # No fallback to whole-result replay if the live bridge is incomplete.
                                if event['text'] != record['text']:
                                    raise ValueError('模型流式回复与最终结果不一致，已停止剩余播报。')
                                record['speech_text'] = record['text']
                                parts = buffer.finish()
                            for part in parts:
                                seq += 1
                                await queue.put((seq,part,False))
                        elif event['type'] == 'cancelled':
                            raise ValueError('本轮模型回复已取消。')
                except Exception as error:
                    await fail_output(error)
                    raise
                finally:
                    if notice_task:
                        notice_task.cancel()
                        await asyncio.gather(notice_task,return_exceptions=True)
                    await stream.aclose()
            if 'agent_complete_at' not in record: raise ValueError('模型回复未完整结束。')
            await queue.put(None)

        async def play_segment(seq, part, notice):
            if generation != self.generation or (notice and answer_ready.is_set()): return
            segment = {'id':seq,'text':part,'kind':'status' if notice else 'answer','requested_at':time.monotonic()}
            record['segments'].append(segment)
            record['tts_started'] = True
            self.notify()
            pending = b''
            async with aclosing(self.synthesize(part,self.tts_url,speed=self.tts_speed,metrics=segment)) as stream:
                async for pcm in stream:
                    if generation != self.generation: return
                    if notice and answer_ready.is_set() and 'notice_first_pcm_at' not in record: return
                    pending += pcm
                    size = len(pending)//2*2
                    if not size: continue
                    # Native chunks stay below the 8192-byte IPC limit.
                    for offset in range(0,size,4096):
                        chunk = pending[offset:min(offset+4096,size)]
                        if notice: record.setdefault('notice_first_pcm_at',time.monotonic())
                        else:
                            record.setdefault('first_pcm_at', time.monotonic())
                            record.setdefault('answer_first_pcm_at',record['first_pcm_at'])
                        if not await self.audio.write(chunk,generation,seq): return
                        record.setdefault('notice_first_enqueue_at' if notice else 'first_enqueue_at', time.monotonic())
                    pending = pending[size:]
            if pending: raise ValueError('合成音频尾部不完整。')
            segment['http_closed_at'] = time.monotonic()
        async def speak():
            while item := await queue.get():
                seq, part, notice = item
                if not notice:
                    await play_segment(seq,part,False)
                    continue
                if answer_ready.is_set(): continue
                playing = asyncio.create_task(play_segment(seq,part,True))
                ready = asyncio.create_task(answer_ready.wait())
                try:
                    await asyncio.wait((playing,ready),return_when=asyncio.FIRST_COMPLETED)
                    if ready.done() and 'notice_first_pcm_at' not in record: playing.cancel()
                    try: await playing
                    except asyncio.CancelledError:
                        if not answer_ready.is_set(): raise
                finally:
                    ready.cancel()
                    if not playing.done(): playing.cancel()
                    await asyncio.gather(playing,ready,return_exceptions=True)
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
            if generation == self.generation:
                if not self.inputs: self.draft = None
                self.notify()

    async def _control(self, command):
        if command == '/stop':
            await self.invalidate('stop')
            self.unsubmitted = ''
            if not self.inputs: self.draft = None
            self.log('已停止当前回复，继续聆听。')
        elif command in ('/mute','/unmute','/end','/start'):
            self.paused_at = None
            self.epoch += 1
            self.inputs.clear()
            self.draft = None
            if self.reset_input: self.reset_input(self.epoch)
            if command == '/end':
                self.intent_active = self.active = False
                await self.invalidate('end')
                self.unsubmitted = ''
            elif command == '/start': self.intent_active, self.active, self.muted = True, True, False
            else: self.muted = command == '/mute'
            if not getattr(self.audio,'closed',False):
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
        self.audio_failed = False
        self.active = self.intent_active and not self.quit
        await self.audio.clear(self.generation)
        await self.audio.capture(self.active and not self.muted,self.epoch)
        self.log('正在聆听。' if self.active and not self.muted else '已静音。' if self.active else '交流已结束；输入 /start 重新开始。')

        self.notify()

    async def close(self):
        try: await self.invalidate('close')
        finally:
            for task in self.tasks:
                if not task.cancelling(): task.cancel()
            await self.wait_idle()
