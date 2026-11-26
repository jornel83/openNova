"""Optional task reports share TTS, but never create foreground model turns."""
import asyncio
from contextlib import suppress
import time


def microphone_control(value):
    return (value.get('action') if isinstance(value, dict) else value) in ('mute','unmute','/mute','/unmute')


def pending_values(queue, waiter):
    # These bounded queues belong to the same event loop. Peek synchronously,
    # without consuming/reordering commands that the main loop must apply.
    values = list(queue._queue)
    if waiter.done():
        if waiter.cancelled() or waiter.exception() is not None: values.append(None)
        else: values.append(waiter.result())
    return values


def notification_input_idle(capture, audio, events, commands, event_wait, command_wait, control_reader, starting, *, muted=False, epoch=None, after_claim=False):
    # get() futures can already hold a turn/control outside its queue. Raw PCM
    # only blocks admission: quiet frames must not cancel an ongoing report.
    def ignored_input(event):
        return (isinstance(event,dict) and event.get('type') in
                ('start','partial','final','end','failed','notice','evidence','zero_input','tick')
                and (muted or epoch is not None and event.get('epoch') != epoch))
    pending_commands = pending_values(commands,command_wait)
    return (all(ignored_input(event) for event in pending_values(events,event_wait))
            and (not pending_commands or (not starting or after_claim) and all(microphone_control(c) for c in pending_commands))
            and not control_reader.done()
            and (muted or not starting or audio.input.empty())
            and (muted or capture.notification_idle(1.2 if starting and not after_claim else .12,require_capture=starting and not after_claim)))


class TaskNotificationSpeaker:
    def __init__(self, controller, bridge, *, input_idle, activity_stamp, claim_idle=None,
                 interval=.5, spacing=3., watch_interval=.04, clock=time.monotonic):
        self.controller, self.bridge = controller, bridge
        self.input_idle, self.activity_stamp = input_idle, activity_stamp
        self.claim_idle = claim_idle or (lambda:self.input_idle(True))
        self.interval, self.spacing, self.watch_interval, self.clock = interval, spacing, watch_interval, clock
        self.attempted = {}  # Insertion order keeps bounded wire exclusions recent.
        self.not_before = 0.

    def connected(self, *, playing=False):
        held = self.bridge.held
        controls_ok = not held or playing and all(microphone_control(getattr(self.bridge,'seen',{}).get(ident)) for ident in held)
        return self.bridge.registered and not self.bridge.closed and not self.bridge.retired and controls_ok

    def can_play(self):
        c = self.controller
        return (self.connected(playing=True) and c.active and not c.quit and not c.audio_failed
                and not c.inputs and not c.draft and c.paused_at is None and self.input_idle(False))

    def ready(self):
        return (self.clock() >= self.not_before and self.connected()
                and self.controller.notification_idle() and self.input_idle(True))

    def stamp(self):
        c = self.controller
        return c.generation, c.activity_revision, self.activity_stamp()

    async def ack(self, ident, status):
        # Claim has already persisted consumption. Ack failures cannot replay audio.
        with suppress(Exception):
            await self.bridge.call('/task-notification-ack',
                {'id':ident,'voiceInstanceId':self.bridge.instance_id,'status':status})

    async def still_current(self, ident):
        try:
            result = await self.bridge.call('/task-notification-active',
                {'id':ident,'voiceInstanceId':self.bridge.instance_id})
            return result.get('valid') is True
        except Exception: return False

    async def watch_current(self, ident, record, task):
        while not task.done():
            await asyncio.sleep(.5)
            if task.done(): return
            if not await self.still_current(ident):
                if self.controller.response_record is record:
                    await self.controller.invalidate('notification_stale')
                return

    async def step(self):
        if not self.ready(): return
        body = {'voiceInstanceId':self.bridge.instance_id}
        result = await self.bridge.call('/task-notification-next',
            {**body,'excludeIds':list(self.attempted)[-256:]})
        notification = result.get('notification')
        if not isinstance(notification,dict) or not isinstance(notification.get('id'),str): return
        ident = notification['id']
        if ident in self.attempted or not self.ready(): return
        stamp = self.stamp()
        # Mark before the request: a lost response may have consumed it remotely.
        self.attempted[ident] = True
        result = await self.bridge.call('/task-notification-claim',{**body,'id':ident})
        notification = result.get('notification')
        if notification is None:
            # An explicit rejection is safe to retry when the host becomes idle.
            self.attempted.pop(ident,None)
            return
        self.not_before = self.clock()+self.spacing
        if not isinstance(notification,dict) or notification.get('id') != ident:
            await self.ack(ident,'skipped')
            return
        if not self.ready_after_claim(stamp):
            await self.ack(ident,'skipped')
            return
        # No await between the final idle check and claiming the local TTS slot.
        started = self.controller.start_task_notification(notification,self.can_play,
            before_play=lambda:self.still_current(ident))
        if not started:
            await self.ack(ident,'skipped')
            return
        task, record = started
        current_watch = asyncio.create_task(self.watch_current(ident,record,task))
        try:
            while not task.done():
                await asyncio.wait((task,),timeout=self.watch_interval)
                if not self.can_play() and self.controller.response_record is record:
                    await self.controller.invalidate('notification_input')
            await asyncio.gather(task,return_exceptions=True)
        finally:
            current_watch.cancel()
            await asyncio.gather(current_watch,return_exceptions=True)
            if not task.done() and self.controller.response_record is record:
                await self.controller.invalidate('notification_closed')
            self.not_before = self.clock()+self.spacing
            status = {'complete':'played','interrupted':'interrupted','failed':'failed'}.get(record['status'],'skipped')
            await self.ack(ident,status)

    def ready_after_claim(self, stamp):
        # The claim's network wait must not hide even an already-ended input turn.
        return (stamp == self.stamp() and self.connected(playing=True)
                and self.controller.notification_idle() and self.claim_idle())

    async def run(self):
        while not self.controller.quit and not self.bridge.closed:
            try: await self.step()
            except Exception: pass  # Optional reports never take down live conversation.
            await asyncio.sleep(self.interval)
