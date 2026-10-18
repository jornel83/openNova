"""Bounded, optional UI telemetry/control. Network waits never run on audio paths."""
import asyncio
from contextlib import suppress
import uuid


def matches_control(command, controller, instance_id):
    if command.get('voiceInstanceId') != instance_id: return False
    if command.get('action') == 'stop':
        return (command.get('generation') == controller.generation and
                command.get('requestId') == (controller.response_record or {}).get('requestId'))
    return command.get('action') in ('mute','unmute','end','start','retry')


class UiBridge:
    def __init__(self, api, instance_id=None, *, interval=1., timeout=2.):
        self.api, self.instance_id = api, instance_id or str(uuid.uuid4())
        self.interval, self.timeout = interval, timeout
        self.state = dict(generation=0,captureEpoch=0,capture='off',recognition='idle',playback='idle',requestId=None,draft=None)
        self.seq = 0
        self.closed = False
        self.retired = False
        self.changed = asyncio.Event()
        self.seen, self.acks, self.held = {}, {}, set()
        self.last_sent = None
        self.registered = False

    def publish(self, update):
        self.state.update(update)
        self.changed.set()

    def ack(self, command_id, result):
        command = command_id if isinstance(command_id,dict) else self.seen[command_id]
        ack = {k:command.get(k) for k in ('id','generation','voiceInstanceId')}
        ack['status'] = result.get('status','failed')
        self.acks[command['id']] = ack
        self.seen[command['id']] = {**command,'result':ack}
        self.changed.set()

    async def call(self, path, body):
        return await asyncio.wait_for(self.api(path,body),self.timeout)

    async def _publish(self, commands):
        while not self.closed:
            self.changed.clear()
            try:
                for ident,ack in tuple(self.acks.items()):
                    try: await self.call('/voice/ack',ack)
                    except ValueError as e:
                        if 'stale_voice_control' not in str(e): raise
                    self.acks.pop(ident,None);self.held.discard(ident)
                # Keep the last acknowledged state while a native control is being applied.
                data = self.last_sent if self.held and self.last_sent else self.state.copy()
                self.seq += 1
                await self.call('/voice/publish',{**data,'voiceInstanceId':self.instance_id,'seq':self.seq})
                self.last_sent = data.copy();self.registered = True
            except Exception as error:
                self.registered = False
                if str(error) in ('stale_voice_instance','voice_in_use'):
                    self.retired = self.closed = True
                    await commands.put('/voice-owner-lost')
                    return
            with suppress(asyncio.TimeoutError): await asyncio.wait_for(self.changed.wait(),self.interval)
            # Bound HTTP traffic even during dense PCM/ASR events.
            await asyncio.sleep(.04)

    async def _poll(self, commands):
        while not self.closed:
            try:
                if not self.registered:
                    await asyncio.sleep(self.interval);continue
                if self.held:
                    await asyncio.sleep(.04);continue
                result = await self.call('/voice/poll',{'voiceInstanceId':self.instance_id})
                for c in result.get('commands',[]):
                    if c.get('voiceInstanceId') != self.instance_id: continue
                    previous = self.seen.get(c['id'])
                    if previous:
                        if previous.get('result'): self.acks[c['id']] = previous['result'];self.changed.set()
                        continue
                    self.seen[c['id']] = c;self.held.add(c['id'])
                    await commands.put(c)
                    if len(self.seen)>256:
                        for ident,old in tuple(self.seen.items()):
                            if old.get('result') and ident not in self.acks: self.seen.pop(ident);break
                    break  # One in-flight command; later Stop can take priority on the host.
            except Exception: await asyncio.sleep(self.interval)

    async def connect(self):
        # Claim the native owner before starting a microphone, not after.
        self.seq += 1
        await self.call('/voice/publish',{**self.state,'voiceInstanceId':self.instance_id,'seq':self.seq})
        self.last_sent = self.state.copy()
        self.registered = True

    async def run(self, commands):
        jobs=[asyncio.create_task(self._publish(commands)),asyncio.create_task(self._poll(commands))]
        try: await asyncio.gather(*jobs)
        finally:
            for job in jobs: job.cancel()
            await asyncio.gather(*jobs,return_exceptions=True)

    async def close(self):
        self.closed=True;self.changed.set();self.seq+=1
        if self.retired: return
        with suppress(Exception):
            await self.call('/voice/publish',{**self.state,'connected':False,'capture':'off','recognition':'idle','playback':'idle','draft':None,'voiceInstanceId':self.instance_id,'seq':self.seq})
