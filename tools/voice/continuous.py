"""Continuous conversation state: input, generation and playback have separate lifetimes."""
import asyncio
from contextlib import aclosing
import os
import time
from segments import SentenceBuffer
from speech_pipeline import prepare_speech
from tts_stream import synthesize as synthesize_pcm
from barge_in import BargeInCandidate, PAUSE_TIMEOUT
from bot_agent import BotRequestFailure, BotRequestCancelled


class NotificationInterrupted(Exception):
    """Unsolicited audio yielded to input without creating a failed reply."""


def effective(text):
    return isinstance(text, str) and any(char.isalnum() for char in text)


class Conversation:
    def __init__(self, agent, audio, tts_url, *, synthesize=synthesize_pcm, log=print, reset_input=None, render_text=None, tts_speed=1.5, on_state=None, prefetch=None, on_evidence=None):
        self.agent, self.audio, self.tts_url = agent, audio, tts_url
        self.on_state = on_state
        self.on_evidence = on_evidence
        self.draft = None
        self.audio_failed = False
        self.problem = None
        self.tts_speed = tts_speed
        self.prefetch = os.environ.get('OPENNOVA_TTS_PREFETCH','1')!='0' if prefetch is None else bool(prefetch)
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
        self.notification_records = []
        self.activity_revision = 0
        self.interrupted = False
        self.unsubmitted = ''
        self.unsubmitted_project = None
        self.project_captures = set()
        self.notice_delay = 2.0
        self.paused_at = None

    def voice_state(self):
        record = self.response_record or {}
        notice = record.get('failure_notice') or {}
        running = record.get('status') == 'running' or notice.get('status') == 'playing'
        playback = getattr(self.audio,'playback','idle') if running else 'idle'
        if playback == 'idle' and running and (record.get('tts_started') or notice.get('status') == 'playing'): playback = 'buffering'
        return dict(generation=self.generation,captureEpoch=self.epoch,
            capture='error' if self.audio_failed else 'off' if not self.active or self.quit else 'muted' if self.muted else 'listening',
            recognition='recognizing' if any(not t['finished'] for t in self.inputs.values()) else 'idle',
            playback='error' if self.audio_failed else playback,requestId=record.get('requestId') if running else None,draft=self.draft,problem=self.problem)

    def notify(self):
        if self.on_state: self.on_state(self.voice_state())

    def evidence(self, event, record=None, **fields):
        if not self.on_evidence: return
        record = record or {}
        project = record.get('expected_project') or {}
        self.on_evidence({'event':event,'generation':record.get('generation',self.generation),
            'captureEpoch':self.epoch,'requestId':record.get('requestId'),
            'entryProjectId':project.get('projectId'),'entryProjectRevision':project.get('revision'),**fields})

    async def capture_project(self):
        capture = getattr(self.agent,'project_context',None)
        if capture is None: return {'expected_project':None}
        try:
            async with asyncio.timeout(3):
                value = await capture()
            return {'expected_project':dict(value)}
        except Exception:
            return {'project_error':'无法确认说话开始时的项目，这段语音没有提交。请连接后重新说话。'}

    def clear_inputs(self):
        for turn in self.inputs.values():
            capture = turn.get('project_capture')
            if capture and not capture.done(): capture.cancel()
        self.inputs.clear()

    async def handle(self, event):
        if event.get('type') != 'tick' and event.get('epoch') == self.epoch and not self.muted and self.active:
            self.activity_revision += 1
        try: await self._handle(event)
        finally: self.notify()

    async def control(self, command):
        if command not in ('/mute','/unmute'): self.activity_revision += 1
        try: await self._control(command)
        finally: self.notify()

    async def invalidate(self, reason):
        self.paused_at = None
        self.generation += 1
        response, record = self.response, self.response_record
        self.response = self.response_record = None
        if record: self.evidence('output_invalidated',record,reason=reason)
        if response and not response.done():
            if record and record['status'] == 'running':
                record.update(status='interrupted', interruption=reason, stopped_at=time.monotonic())
                if record.get('kind') != 'task_notification':
                    self.interrupted = True
                    if not record.get('admitted'):
                        self.unsubmitted = record['input']
                        self.unsubmitted_project = record.get('expected_project')
                record['segments_with_played_chunks'] = sorted(getattr(self.audio, 'played_segments', set()))
                self.capture_playback_metrics(record)
            if not response.cancelling(): response.cancel()
        # Stop locally before waiting for model/HTTP cleanup, which runs in the cancelled task.
        if not getattr(self.audio,'closed',False):
            clear_generation = self.generation
            await self.audio.clear(clear_generation)
            if record:
                record['local_clear_ack_at'] = time.monotonic()
                self.evidence('output_cleared',record,nativeGeneration=clear_generation,reason=reason)
        self.notify()

    def capture_playback_metrics(self, record):
        receipts = getattr(self.audio,'playback_times',{})
        for segment in record.get('segments',[]):
            if segment['id'] in receipts:
                segment.setdefault('first_playback_feedback_at',receipts[segment['id']])
                if segment['kind']=='answer':
                    record.setdefault('first_playback_feedback_at',receipts[segment['id']])

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
            if (self.response_record or {}).get('kind') == 'task_notification':
                # A report is optional: yield at VAD start, without waiting for ASR.
                await self.invalidate('speech')
            guarded = bool(self.response and not self.response.done())
            self.inputs[ident] = {'final':None,'finished':False,'confirmed':False,'text':'',
                'candidate':BargeInCandidate() if guarded else None,
                'generation':self.generation,'record':self.response_record if guarded else None}
            if getattr(self.agent,'project_context',None) is not None:
                capture = asyncio.create_task(self.capture_project())
                self.inputs[ident]['project_capture'] = capture
                self.project_captures.add(capture)
                capture.add_done_callback(self.project_captures.discard)
            self.draft = {'text':'','utteranceId':str(ident),'requestId':None}
            if guarded:
                self.inputs[ident]['candidate'].update({**event,'time':now})
                self.trace_candidate(self.inputs[ident], 'candidate')
            # Start the local snapshot request now; ASR and VAD continue independently.
            if self.inputs[ident].get('project_capture'): await asyncio.sleep(0)
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
            turn.update(finished=True, final=turn['text'] if keep else None, final_at=now)
            if candidate and not keep: self.trace_candidate(turn, 'filtered_final')
        elif kind == 'failed':
            turn.update(finished=True, final=None)
            if candidate: self.trace_candidate(turn, 'asr_failed')
            if not candidate or turn['confirmed']:
                self.problem = '这段语音未能识别，请重新说话。'
                self.log(event.get('error','本轮识别未完成，请重新说话。'))
        elif kind == 'end':
            turn['ended_at'] = event.get('time', time.monotonic())
        if self.inputs and all(turn['finished'] for turn in self.inputs.values()):
            texts = [turn['final'] for _,turn in sorted(self.inputs.items()) if turn['final']]
            if texts:
                ended = max(turn.get('ended_at',turn['final_at']) for turn in self.inputs.values() if turn['final'])
                asr_final = max(turn['final_at'] for turn in self.inputs.values() if turn['final'])
                epoch = self.epoch
                selected = [turn for _,turn in sorted(self.inputs.items()) if turn['final']]
                try:
                    captures = [await turn['project_capture'] if turn.get('project_capture') else {'expected_project':None} for turn in selected]
                except asyncio.CancelledError:
                    if epoch != self.epoch or self.muted or not self.active: return
                    raise
                if epoch != self.epoch or self.muted or not self.active: return
                self.clear_inputs()
                error = next((capture.get('project_error') for capture in captures if capture.get('project_error')),None)
                expected = captures[0].get('expected_project')
                if not error and any(capture.get('expected_project') != expected for capture in captures):
                    error = '说话期间当前项目已变化，这几段语音没有合并提交。请确认项目后重新说话。'
                if error:
                    self.draft = None
                    self.log(error)
                    await self.resume_candidate('project_changed')
                    return
                await self.ask('\n'.join(texts), ended, asr_final_at=asr_final,expected_project=expected)
            else:
                await self.resume_candidate('unconfirmed')
                self.clear_inputs()
                self.draft = None

    async def ask(self, text, ended_at=None, *, asr_final_at=None, expected_project=None):
        if expected_project is None and getattr(self.agent,'project_context',None) is not None:
            captured = await self.capture_project()
            if captured.get('project_error'):
                self.log(captured['project_error'])
                return
            expected_project = captured['expected_project']
        self.activity_revision += 1
        await self.invalidate('replacement')
        original = text
        if self.unsubmitted:
            if self.unsubmitted_project == expected_project:
                text = self.unsubmitted+'\n'+text
            else:
                self.log('项目已变化，上一段尚未提交的语音未合并；需要时请在原项目重新说话。')
            self.unsubmitted = ''
            self.unsubmitted_project = None
        if self.interrupted:
            text = '[语音状态：上一段回复的播报已被打断，用户可能未听完；无需从头重播。]\n'+text
            self.interrupted = False
        record = {'input':original,'text':'','status':'running','generation':self.generation,
                  'submitted_at':time.monotonic(),'input_ended_at':ended_at,'segments':[], 'admitted':False,
                  'output_mode':getattr(self.agent,'output_mode','incremental'),'speech_text':'','sources':[],'tool_events':[]}
        self.problem = None
        if expected_project is not None: record['expected_project'] = dict(expected_project)
        if asr_final_at is not None: record['asr_final_at']=asr_final_at
        self.records.append(record)
        self.evidence('turn_started',record)
        self.response_record = record
        task = asyncio.create_task(self._respond(text, record))
        self.response = task
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        self.notify()
        self.log('你：'+original)
        self.log('正在思考，麦克风保持静音。' if self.muted else '正在思考，麦克风继续聆听。')

    def notification_idle(self):
        return (self.active and not self.quit and not self.audio_failed
                and not self.inputs and not self.draft and self.paused_at is None
                and not self.agent_lock.locked()
                and (self.response is None or self.response.done())
                and getattr(self.audio,'playback','idle') == 'idle')

    def start_task_notification(self, notification, can_play, before_play=None):
        """Reserve the same playback slot synchronously, without a model turn."""
        if not self.notification_idle() or not can_play(): return None
        text = notification.get('speechText') or notification.get('text')
        if not isinstance(text,str) or not text.strip() or len(text)>6000: return None
        record = {'kind':'task_notification','notificationId':notification['id'],
                  'text':text,'speech_text':text,'status':'running','generation':self.generation,
                  'submitted_at':time.monotonic(),'segments':[],'output_mode':'notification',
                  'can_play':can_play,'before_play':before_play}
        self.notification_records.append(record)
        self.response_record = record
        task = asyncio.create_task(self._respond(text,record))
        self.response = task
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        self.notify()
        return task,record

    async def _respond(self, text, record):
        generation = record['generation']
        queue = asyncio.Queue(maxsize=8)
        settled = record['output_mode'] == 'settled-answer'
        hybrid = record['output_mode'] == 'hybrid-stream'
        record['tts_prefetch'] = self.prefetch
        answer_ready = asyncio.Event()
        async def delayed_notice():
            await asyncio.sleep(self.notice_delay)
            if generation == self.generation and not answer_ready.is_set():
                await queue.put((0,'我查一下，请稍等。',True))
        async def produce():
            buffer = SentenceBuffer()
            if record.get('kind') == 'task_notification':
                answer_ready.set()
                self.log('任务汇报：'+text)
                for seq,part in enumerate(buffer.feed(text)+buffer.finish(),1):
                    await queue.put((seq,part,False))
                await queue.put(None)
                return
            attempt = None
            seq = 0
            notice_task = None
            async with self.agent_lock:
                if generation != self.generation: return
                record['admitted'] = True
                stream = (self.agent.stream(text,expected_project=record['expected_project'])
                          if record.get('expected_project') is not None else self.agent.stream(text))
                try:
                    async for event in stream:
                        if generation != self.generation: return
                        if event['type'] == 'request':
                            record['requestId'] = event['id']
                            self.evidence('request_bound',record)
                            if self.draft: self.draft = {**self.draft,'requestId':event['id']}
                            self.notify()
                        elif event['type'] == 'status':
                            phase = event.get('phase')
                            record['tool_events'].append({'phase':phase,'step':event.get('step'),'at':time.monotonic()})
                            if phase == 'retrying':
                                self.log(f"模型暂时繁忙，正在自动重试（{event['retry']}/{event['maxRetries']}）……")
                            if phase in ('searching','reading','requesting','processing','verifying'):
                                self.log({'searching':'正在联网搜索。','reading':'正在读取资料。','requesting':'正在获取数据。','processing':'正在处理数据。','verifying':'正在核对结果。'}[phase])
                                if (settled or hybrid) and notice_task is None: notice_task = asyncio.create_task(delayed_notice())
                        elif event['type'] == 'sources':
                            # Pending evidence is not presented as a completed answer.
                            record['sources_received_at'] = time.monotonic()
                        elif event['type'] == 'draft':
                            if not hybrid: raise ValueError('当前模式不支持回答草稿。')
                            draft = event['text']
                            if len(draft)>16000: raise ValueError('模型回复过长，已停止本轮。')
                            if draft:
                                if 'first_delta_at' not in record:
                                    record['first_delta_at']=time.monotonic()
                                    self.render_text('OpenNova：')
                                self.render_text(draft[len(record['text']):] if draft.startswith(record['text']) else '\nOpenNova：'+draft)
                            record['text']=draft
                            if event.get('timings'): record['model_timings']=event['timings']
                        elif event['type'] == 'speech-delta':
                            if not hybrid: raise ValueError('当前模式不支持增量播报。')
                            current_attempt=event.get('attemptId')
                            if attempt and attempt!=current_attempt:
                                raise ValueError('模型重新生成了本轮回复，已停止旧播报，请重新说话。')
                            attempt=current_attempt
                            record.setdefault('first_speech_delta_at',time.monotonic())
                            record['speech_text']+=event['text']
                            if len(record['speech_text'])>6000: raise ValueError('播报内容过长。')
                            answer_ready.set()
                            for part in buffer.feed(event['text']):
                                seq+=1
                                await queue.put((seq,part,False))
                        elif event['type'] == 'delta':
                            if settled or hybrid: raise ValueError('当前模式不应提前播报未确认的模型文本。')
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
                            if hybrid:
                                speech=event.get('speechText')
                                if (not isinstance(speech,str) or not speech.strip() or len(speech)>6000
                                        or len(event['text'])>16000 or not speech.startswith(record['speech_text'])
                                        or not event['text'].startswith(record['text'])):
                                    raise ValueError('流式回答与最终结果不一致，已停止剩余播报。')
                                if not record['text']: self.render_text('OpenNova：')
                                self.render_text(event['text'][len(record['text']):]+'\n')
                                parts=buffer.feed(speech[len(record['speech_text']):])+buffer.finish()
                                record.update(text=event['text'],speech_text=speech,sources=event.get('sources',[]))
                                for source in record['sources']:
                                    self.log(f"来源 {source['id']}：{source['title']} {source['url']}")
                            elif settled:
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
                            raise BotRequestCancelled('本轮请求已取消。')
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

        def segment_metrics(item):
            seq,part,notice=item
            segment = {'id':seq,'text':part,'kind':'status' if notice else 'answer'}
            record['segments'].append(segment)
            record['tts_started'] = True
            self.notify()
            return segment

        def prepare(part,segment):
            return self.synthesize(part,self.tts_url,speed=self.tts_speed,metrics=segment)

        async def play_segment(job):
            seq,notice,segment=job.seq,job.notice,job.metrics
            if generation != self.generation or (notice and answer_ready.is_set()): return
            async with aclosing(job.pcm()) as stream:
                async for pcm in stream:
                    if generation != self.generation: return
                    before_play = record.pop('before_play',None)
                    valid = await before_play() if before_play else True
                    # The HTTP preflight may have crossed new local input; recheck
                    # synchronously before ever handing PCM to the native device.
                    if generation != self.generation: return
                    if not valid or (record.get('can_play') and not record['can_play']()):
                        record.update(status='interrupted',interruption='notification_stale' if not valid else 'input_pending')
                        self.generation += 1
                        await self.audio.clear(self.generation)
                        raise NotificationInterrupted()
                    if notice and answer_ready.is_set() and 'notice_first_pcm_at' not in record: return
                    if notice: record.setdefault('notice_first_pcm_at',segment['first_pcm_at'])
                    else:
                        record.setdefault('first_pcm_at',segment['first_pcm_at'])
                        record.setdefault('answer_first_pcm_at',record['first_pcm_at'])
                    if not await self.audio.write(pcm,generation,seq): return
                    segment.setdefault('first_enqueue_at',time.monotonic())
                    record.setdefault('notice_first_enqueue_at' if notice else 'first_enqueue_at',segment['first_enqueue_at'])
        async def speak():
            prepared=prepare_speech(queue,prepare,lambda:generation==self.generation,segment_metrics,lookahead=1 if self.prefetch else 0)
            async with aclosing(prepared) as jobs:
                async for job in jobs:
                    if not job.notice:
                        await play_segment(job)
                        continue
                    if answer_ready.is_set(): continue
                    playing=asyncio.create_task(play_segment(job))
                    ready=asyncio.create_task(answer_ready.wait())
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
            self.capture_playback_metrics(record)

        async def fail_output(error):
            if record['status'] != 'running': return
            while isinstance(error, BaseExceptionGroup): error = error.exceptions[0]
            cancelled = isinstance(error,BotRequestCancelled)
            if cancelled:
                record.update(status='interrupted',interruption='cancelled')
            else:
                record.update(status='failed',error='reply_interrupted',failed_at=time.monotonic())
                if isinstance(error,BotRequestFailure):
                    record.update(error=error.code,failure_stage=error.stage,userMessage=error.user_message)
            if generation == self.generation:
                self.generation += 1
                clear_generation = self.generation
                record['failure_generation'] = clear_generation
                if cancelled: self.problem = None
                elif isinstance(error,BotRequestFailure): self.problem = error.user_message
                if not self.inputs and (self.draft or {}).get('requestId') == record.get('requestId'):
                    self.draft = None
                # A failed model turn does not disconnect the voice client or
                # disable capture. Publish before async cleanup can yield input.
                self.notify()
                try:
                    await self.audio.clear(clear_generation)
                    record['local_clear_ack_at'] = time.monotonic()
                    self.evidence('output_cleared',record,nativeGeneration=clear_generation)
                except Exception: pass
                if record['text']: self.render_text('\n')
                if isinstance(error,BotRequestFailure): self.log(error.user_message)
                elif not cancelled: self.log('回复中断：'+str(error)+' 已显示的文字保留，可继续说话。')

        async def guarded(work):
            try: await work()
            except NotificationInterrupted: raise
            except Exception as error:
                await fail_output(error)
                raise

        try:
            async with asyncio.TaskGroup() as group:
                group.create_task(guarded(produce))
                group.create_task(guarded(speak))
            if generation == self.generation:
                record.update(status='complete', completed_at=time.monotonic())
                self.log(('任务汇报结束，' if record.get('kind') == 'task_notification' else '回复完成，')+
                         ('麦克风保持静音。' if self.muted else '正在聆听。'))
        except asyncio.CancelledError:
            if record['text']: self.render_text('\n')
            record.setdefault('interruption','cancelled')
            if record['status'] == 'running': record['status'] = 'interrupted'
            record['local_pipeline_closed_at'] = time.monotonic()
            raise
        except Exception as error:
            await fail_output(error)
            if (record.get('userMessage') and self.response_record is record
                    and record.get('failure_generation') == self.generation):
                # Python 3.11 TaskGroup may leave an internal cancellation count
                # on its parent. Give Stop/barge-in a fresh owned playback task.
                notice=asyncio.create_task(self.speak_request_problem(record))
                self.response=notice
                self.tasks.add(notice)
                notice.add_done_callback(self.tasks.discard)
                await notice
        finally:
            record['pipeline_closed_at'] = time.monotonic()
            self.evidence('turn_settled',record,status=record['status'])
            durations={}
            for name,start,end in (
                ('asr_finalize_ms','input_ended_at','asr_final_at'),
                ('asr_to_submit_ms','asr_final_at','submitted_at'),
                ('submit_to_first_text_ms','submitted_at','first_delta_at'),
                ('submit_to_first_pcm_ms','submitted_at','first_pcm_at'),
                ('input_end_to_first_pcm_ms','input_ended_at','first_pcm_at'),
                ('input_end_to_first_enqueue_ms','input_ended_at','first_enqueue_at'),
                ('input_end_to_first_playback_feedback_ms','input_ended_at','first_playback_feedback_at'),
            ):
                if isinstance(record.get(start),(int,float)) and isinstance(record.get(end),(int,float)):
                    durations[name]=round(max(0,record[end]-record[start])*1000,3)
            record['latency_ms']=durations
            record['latency_notes']={'inputEnd':'VAD endpoint after configured silence window; not acoustic last speech sample',
                                     'playbackFeedback':'first native PCM chunk playback receipt; not acoustic first sound'}
            if generation == self.generation:
                if not self.inputs: self.draft = None
                self.notify()
            elif record.get('kind') == 'task_notification': self.notify()

    async def speak_request_problem(self, record):
        """One bounded notice in the existing playback slot, never another model turn."""
        if record.get('failure_notice'): return
        generation=self.generation
        def current():
            return (self.response_record is record and generation == self.generation
                    and self.active and not self.quit and not self.audio_failed
                    and not getattr(self.audio,'closed',False))
        notice=record['failure_notice']={'status':'skipped'}
        # Yield to input that began while model/output cleanup was completing.
        if not current() or self.inputs or self.draft: return
        notice['status']='playing'
        self.notify()
        segment=1+max((part['id'] for part in record['segments']),default=0)
        try:
            received=False
            async with asyncio.timeout(25):
                async with aclosing(self.synthesize(record['userMessage'],self.tts_url,speed=self.tts_speed,metrics=notice)) as stream:
                    async for pcm in stream:
                        if not current():notice['status']='interrupted';return
                        received=received or bool(pcm)
                        if not await self.audio.write(pcm,generation,segment):notice['status']='interrupted';return
                if not received:raise ValueError('empty_failure_notice')
                if not current():notice['status']='interrupted';return
                await self.audio.drained(generation)
                notice['status']='spoken'
        except asyncio.CancelledError:
            notice['status']='interrupted'
            raise
        except Exception:
            # Keep the original model/routing problem visible; a TTS outage must
            # not recursively synthesize another error or become a device error.
            notice['status']='unavailable'
            if current():
                try:await self.audio.clear(generation)
                except Exception:pass
                self.log('本轮错误提示未能播报，具体原因已保留在窗口。')
        finally:
            if current():self.notify()

    async def _control(self, command):
        if command == '/stop':
            self.problem = None
            await self.invalidate('stop')
            self.unsubmitted = ''
            self.unsubmitted_project = None
            if not self.inputs: self.draft = None
            self.log('已停止当前回复，麦克风保持静音。' if self.muted else '已停止当前回复，继续聆听。')
        elif command in ('/mute','/unmute','/end','/start'):
            if command in ('/end','/start'): self.problem = None
            self.paused_at = None
            self.epoch += 1
            self.clear_inputs()
            self.draft = None
            if self.reset_input: self.reset_input(self.epoch)
            if command == '/end':
                self.intent_active = self.active = False
                await self.invalidate('end')
                self.unsubmitted = ''
                self.unsubmitted_project = None
            elif command == '/start': self.intent_active, self.active, self.muted = True, True, False
            else: self.muted = command == '/mute'
            if not getattr(self.audio,'closed',False):
                await self.audio.capture(self.active and not self.muted,self.epoch)
                if self.response and not self.response.done(): await self.audio.resume()
            self.log('正在聆听。' if self.active and not self.muted else '麦克风已静音，语音播报保持开启。' if self.active else '交流已结束；输入 /start 重新开始。')
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
        self.clear_inputs()
        if self.reset_input: self.reset_input(self.epoch)
        self.audio_failed = False
        self.problem = None
        self.active = self.intent_active and not self.quit
        await self.audio.clear(self.generation)
        await self.audio.capture(self.active and not self.muted,self.epoch)
        self.log('正在聆听。' if self.active and not self.muted else '麦克风已静音，语音播报保持开启。' if self.active else '交流已结束；输入 /start 重新开始。')

        self.notify()

    async def close(self):
        self.clear_inputs()
        captures = tuple(self.project_captures)
        for capture in captures: capture.cancel()
        if captures: await asyncio.gather(*captures,return_exceptions=True)
        try: await self.invalidate('close')
        finally:
            for task in self.tasks:
                if not task.cancelling(): task.cancel()
            await self.wait_idle()
