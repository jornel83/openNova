"""CLI wiring for continuous capture and for real-service file validation."""
import asyncio
from contextlib import suppress
from functools import partial
import json
import time
from audio_bridge import NativeAudio, check_native
from continuous import Conversation
from controls import read_controls, HELP
from stream_agent import StreamingAgent
from bot_agent import BotAgent
from ui_bridge import UiBridge, matches_control
from turns import TurnCapture
from doubao_asr import recognize, load_pcm, file_chunks, safe_message
from vad import SileroOnnx
from tts_stream import synthesize


class FileAudio:
    """Count generated PCM without opening microphone or speakers (file tests only)."""
    def __init__(self):
        self.generation = self.frames = 0
        self.bytes = 0
    async def clear(self, generation): self.generation = generation
    async def pause(self): pass
    async def resume(self): pass
    async def capture(self, enabled, epoch): pass
    async def write(self, pcm, generation, segment):
        if generation != self.generation: return False
        self.bytes += len(pcm)
        return True
    async def drained(self, generation): pass
    async def close(self): pass


async def stop_foreground(controller, agent):
    """Capture the target before native clear can allow another request to start."""
    request_id = (controller.response_record or {}).get('requestId')
    try:
        # Loopback only; an unavailable host must not hold up the local stop.
        snapshot = await asyncio.wait_for(agent.api('/snapshot',{}),.25)
        request_id = snapshot.get('activeId') or request_id
    except Exception: pass
    await controller.control('/stop')
    if request_id: await agent.api('/voice/cancel-request',{'id':request_id})


async def run(args, key):
    from conversation import preflight, check_cloud_tts, tts_options, default_speed
    provider, voice = tts_options(args)
    if args.audio and not args.no_play:
        raise ValueError('连续模式的文件验证需要 --no-play；现场播报请使用麦克风。')
    if args.no_play and not args.audio:
        raise ValueError('--continuous --no-play 仅用于 --audio 文件验证。')
    if args.output_dir and not args.audio:
        # This mode stores metrics/text only, never microphone PCM.
        print('本次仅保存文字和时序报告，不保存原始收音。',flush=True)
    agent_options = {'web': True} if getattr(args,'web',False) else {}
    agent_factory = BotAgent if getattr(args,'bot',False) else StreamingAgent
    agent = agent_factory(**agent_options)
    audio = FileAudio() if args.audio else NativeAudio(device=args.device, output_device=args.output_device)
    owned_audio = {audio}
    owned_agents = {agent}
    tasks = set()
    controller = capture = bridge = None
    commands = asyncio.Queue(maxsize=16)
    report = {'mode':'continuous_file' if args.audio else 'continuous_microphone',
              'model':'gpt-6.1-sol','tts_provider':provider,'voice':voice,'speed':default_speed(provider),'success':False,
              'acoustic_validation':False,'tts_server_cancellation_verified':False,'turns':[]}
    events = asyncio.Queue(maxsize=256)
    def log(text): print(safe_message(text,key),flush=True)
    def emit(event):
        try: events.put_nowait(event)
        except asyncio.QueueFull:
            # Explicitly invalidate the whole input epoch, never keep a truncated turn.
            while not events.empty(): events.get_nowait()
            events.put_nowait({'type':'audio_failure','error':'语音事件积压，已停止；输入 /retry 重连。'})
    async def asr(source, ident, partial):
        return await recognize(None,key,'volc.seedasr.sauc.duration',audio_source=source,
                               audio_seconds_limit=48,turn_id=ident,on_text=partial)
    async def pump_input(source):
        while True:
            item = await source.input.get()
            if isinstance(item,Exception):
                emit({'type':'audio_failure','error':str(item)})
                return
            epoch, pcm = item
            if controller.active and not controller.muted:
                capture.feed(epoch,pcm)
    async def audio_failure(message):
        controller.active = False
        controller.audio_failed = True
        controller.epoch += 1
        capture.reset(controller.epoch)
        controller.inputs.clear()
        with suppress(Exception): await controller.invalidate('audio_failure')
        with suppress(Exception): await controller.audio.capture(False,controller.epoch)
        controller.draft = None
        controller.notify()
        log(message)
    async def new_audio():
        new = NativeAudio(device=args.device, output_device=args.output_device)
        new.enabled = False  # Retry starts suspended; restore_audio applies current mute/end intent.
        owned_audio.add(new)
        new_agent = None
        published = False
        try:
            if agent.error is not None or (agent.process is not None and agent.process.returncode is not None):
                await controller.wait_idle()
                await agent.close()
                owned_agents.discard(agent)
                new_agent = agent_factory(**agent_options)
                owned_agents.add(new_agent)
                await new_agent.start()
            info = await new.start()
            emit({'type':'audio_ready','audio':new,'info':info,'agent':new_agent})
            published = True
        except asyncio.CancelledError: raise
        except Exception as error: emit({'type':'audio_failure','error':str(error)})
        finally:
            if not published:
                await new.close()
                owned_audio.discard(new)
                if new_agent:
                    await new_agent.close()
                    owned_agents.discard(new_agent)
    try:
        log(f'正在检查流式 Agent、TTS（{provider} / {voice}）和原生音频……')
        if not args.audio:
            info = await check_native(device=args.device, output_device=args.output_device)
            report['audio_check'] = info
            log(f"设备选择：{info['input']} → {info['output']}")
        await asyncio.to_thread(preflight,args)
        await check_cloud_tts(args)
        ready = await agent.start()
        report['session_id'] = ready['sessionId']
        report['output_mode'] = ready.get('outputMode','incremental')
        detector = SileroOnnx()
        if args.check:
            log('检查通过：流式 Agent、VAD、TTS 及音频桥已就绪；未开启麦克风，AEC 听感尚未验证。')
            return
        controller = Conversation(agent,audio,args.tts_url,log=log,
            tts_speed=default_speed(provider),
            synthesize=partial(synthesize,provider=provider,voice=voice),
            render_text=lambda text: print(safe_message(text,key),end='',flush=True))
        capture = TurnCapture(detector,asr,emit,silence_ms=args.silence_ms,extended_ms=args.extended_silence_ms)
        controller.reset_input = capture.reset
        report['turns'] = controller.records
        if args.audio:
            for path in args.audio:
                async for pcm,_ in file_chunks(load_pcm(path)):
                    capture.feed(controller.epoch,pcm)
                    while not events.empty(): await controller.handle(events.get_nowait())
                await capture.finish()
                while not events.empty(): await controller.handle(events.get_nowait())
                await controller.wait_idle()
            report['pcm_bytes'] = audio.bytes
            report['success'] = bool(controller.records) and all(r['status']=='complete' for r in controller.records)
            if not report['success']: raise ValueError('文件链路验证未完整成功，请检查本轮终端状态。')
            log(f'文件验证完成：{len(controller.records)} 轮；未开启麦克风或扬声器。')
            return
        if getattr(args,'bot',False):
            bridge = UiBridge(partial(agent._api,timeout=2))
            await bridge.connect()
            tasks.add(asyncio.create_task(bridge.run(commands)))
            controller.on_state = bridge.publish
            audio.on_state = controller.notify
        info = await audio.start()
        controller.notify()
        report['audio_ready'] = info
        log(f"音频已就绪：{info['input']} → {info['output']}；Voice Processing 已开启，现场效果待验证。")
        log(HELP)
        log('插话过滤已启用：持续人声与转写联合确认，未确认的暂停会自动恢复。')
        if getattr(args,'bot',False):
            log('Bot：文件和记忆直接执行，无需确认。/operations 查看操作记录 · /tasks 查询任务 · /cancel-task 编号 取消任务 · /memory 查看记忆 · /result 查询上一请求。')
        log('正在聆听。')
        control_reader = asyncio.create_task(read_controls(commands)); tasks.add(control_reader)
        input_task = asyncio.create_task(pump_input(audio)); tasks.add(input_task)
        event_wait = asyncio.create_task(events.get()); tasks.add(event_wait)
        command_wait = asyncio.create_task(commands.get()); tasks.add(command_wait)
        retry = None
        while not controller.quit:
            done,_ = await asyncio.wait([event_wait,command_wait,control_reader],
                timeout=.1 if controller.paused_at is not None else None,
                return_when=asyncio.FIRST_COMPLETED)
            if not done:
                # Wall-clock watchdog, independent of incoming microphone/ASR events.
                try: await controller.handle({'type':'tick','epoch':controller.epoch,'time':time.monotonic()})
                except Exception as error: await audio_failure(str(error))
            if command_wait in done:
                incoming = command_wait.result()
                envelope = incoming if isinstance(incoming,dict) else None
                command = '/'+envelope['action'] if envelope else incoming
                status = 'applied'
                try:
                    if envelope and not matches_control(envelope,controller,bridge.instance_id):
                        status = 'stale'
                    elif command == '/voice-owner-lost':
                        log('语音连接已被另一个进程接管，本进程停止收音和播报。')
                        try: await controller.control('/end')
                        finally: await controller.control('/quit')
                    elif command == '/retry':
                        if retry and not retry.done(): log('音频正在重连，请稍候。')
                        else:
                            await audio_failure('正在重建原生音频；本次会话上下文保留。')
                            input_task.cancel()
                            await asyncio.gather(input_task,return_exceptions=True)
                            await controller.audio.close()
                            owned_audio.discard(controller.audio)
                            retry = asyncio.create_task(new_audio()); tasks.add(retry)
                    else:
                        result = await agent.control(command) if getattr(args,'bot',False) else None
                        if result is not None: log(json.dumps(result,ensure_ascii=False,indent=2))
                        else:
                            if command == '/stop' and not envelope and getattr(args,'bot',False):
                                await stop_foreground(controller,agent)
                            else: await controller.control(command)
                except Exception as error:
                    status = 'failed'
                    if getattr(args,'bot',False): log('操作失败：'+str(error))
                    else: await audio_failure(str(error))
                finally:
                    if envelope: bridge.ack(envelope,{'status':status})
                tasks.discard(command_wait)
                command_wait = asyncio.create_task(commands.get()); tasks.add(command_wait)
            if event_wait in done:
                event = event_wait.result()
                if event['type'] == 'audio_failure': await audio_failure(event['error'])
                elif event['type'] == 'audio_ready':
                    if event.get('agent'):
                        controller.agent = agent = event['agent']
                        log('Agent 连接已重建，这是一个新的模型会话。')
                    controller.audio = audio = event['audio']
                    audio.on_state = controller.notify
                    if controller.quit: continue
                    await controller.restore_audio()
                    input_task = asyncio.create_task(pump_input(audio)); tasks.add(input_task)
                else:
                    try: await controller.handle(event)
                    except Exception as error: await audio_failure(str(error))
                tasks.discard(event_wait)
                event_wait = asyncio.create_task(events.get()); tasks.add(event_wait)
            if control_reader in done and control_reader.exception():
                raise ValueError('无法读取终端控制，请在交互式终端启动。')
            if control_reader.done() and not controller.quit:
                # EOF queued /quit; stop including a completed reader in the wait set.
                await controller.control('/quit')
        report['success'] = True
    finally:
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        if capture: await capture.close()
        if controller:
            with suppress(Exception): await controller.close()
        # Ownership is independent of queue/task delivery. A completed get() can
        # hold an audio_ready event across /quit; all resources are still ours.
        for owned in owned_audio:
            with suppress(Exception): await owned.close()
        for owned in owned_agents:
            with suppress(Exception): await owned.close()
        if bridge: await bridge.close()
        report['finished_at'] = time.monotonic()
        if args.output_dir:
            (args.output_dir/'conversation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
