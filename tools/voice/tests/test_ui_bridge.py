import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from ui_bridge import UiBridge, matches_control

class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_publish_is_nonblocking_coalesces_and_heartbeat_recovers(self):
        seen=[];blocked=asyncio.Event()
        async def api(path,body):
            if path=='/voice/publish':
                await blocked.wait();seen.append(body);return {'accepted':True}
            await asyncio.sleep(.01);return {'commands':[]}
        b=UiBridge(api,'v',interval=.01,timeout=.1);q=asyncio.Queue();task=asyncio.create_task(b.run(q))
        for n in range(100):b.publish({'draft':{'text':str(n),'utteranceId':'1'}})
        self.assertEqual(b.state['draft']['text'],'99');blocked.set();await asyncio.sleep(.05)
        self.assertEqual(seen[-1]['draft']['text'],'99');self.assertLess(len(seen),10)
        await b.close();await task
        self.assertFalse(seen[-1]['connected'])
    async def test_command_replay_never_reapplies_and_ack_precedes_changed_generation(self):
        calls=[];c={'id':'c','voiceInstanceId':'v','generation':2,'action':'stop','requestId':'r'}
        async def api(path,body):
            calls.append((path,dict(body)))
            if path=='/voice/poll':await asyncio.sleep(.005);return {'commands':[c]}
            return {}
        b=UiBridge(api,'v',interval=.01);b.publish({'generation':2,'requestId':'r'});q=asyncio.Queue();task=asyncio.create_task(b.run(q))
        command=await asyncio.wait_for(q.get(),.5)
        b.publish({'generation':3,'requestId':None});b.ack(command,{'status':'applied'})
        await asyncio.sleep(.06);self.assertTrue(q.empty())
        ack=next(i for i,(p,_) in enumerate(calls) if p=='/voice/ack')
        update=next(i for i,(p,x) in enumerate(calls) if p=='/voice/publish' and x['generation']==3)
        self.assertLess(ack,update);await b.close();await task
    def test_exact_stop_ownership_but_end_after_retry_generation_is_allowed(self):
        class C: generation=3;response_record={'requestId':'new'}
        c=C();base={'voiceInstanceId':'v','action':'stop','generation':2,'requestId':'old'}
        self.assertFalse(matches_control(base,c,'v'))
        self.assertFalse(matches_control({**base,'generation':3},c,'v'))
        self.assertTrue(matches_control({**base,'generation':3,'requestId':'new'},c,'v'))
        self.assertTrue(matches_control({**base,'action':'end'},c,'v'))
        self.assertFalse(matches_control({**base,'action':'mute','voiceInstanceId':'other'},c,'v'))
    async def test_retired_owner_signals_shutdown_instead_of_silently_retrying(self):
        calls=[]
        async def api(path,body):
            calls.append(path)
            if path=='/voice/publish':raise ValueError('stale_voice_instance')
            return {'commands':[]}
        b=UiBridge(api,'old',interval=.01);q=asyncio.Queue();task=asyncio.create_task(b.run(q))
        try:
            self.assertEqual(await asyncio.wait_for(q.get(),.2),'/voice-owner-lost')
            await asyncio.wait_for(task,.2)
            self.assertEqual(calls.count('/voice/publish'),1)
        finally:
            task.cancel();await asyncio.gather(task,return_exceptions=True)
    async def test_one_inflight_control_leaves_later_stop_at_server_for_priority(self):
        c=lambda n,a:{'id':n,'action':a,'generation':0,'voiceInstanceId':'v','requestId':None}
        async def api(path,body):
            if path=='/voice/poll':await asyncio.sleep(.005);return {'commands':[c('first','mute'),c('second','start')]}
            return {}
        b=UiBridge(api,'v',interval=.01);q=asyncio.Queue();task=asyncio.create_task(b.run(q))
        try:
            self.assertEqual((await asyncio.wait_for(q.get(),.3))['id'],'first')
            await asyncio.sleep(.04);self.assertTrue(q.empty())
        finally:await b.close();await task
    async def test_terminal_stop_captures_old_request_before_native_clear(self):
        from continuous_run import stop_foreground
        current='old';cancelled=[]
        class Agent:
            async def api(self,path,body):
                if path=='/snapshot':return {'activeId':current}
                cancelled.append(body['id'])
        class Controller:
            response_record=None
            async def control(self,command):
                nonlocal current
                self.stopped=True;current='new'
        controller=Controller()
        await stop_foreground(controller,Agent())
        self.assertTrue(controller.stopped);self.assertEqual(cancelled,['old'])
