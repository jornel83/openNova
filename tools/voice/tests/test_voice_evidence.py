"""Durable metadata and project switching through production voice interfaces."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from audio_bridge import NativeAudio
from bot_agent import BotAgent
from continuous import Conversation
from evidence import VoiceEvidence
from ui_bridge import UiBridge, matches_control
from test_continuous import Audio

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = Path(__file__).parent/'fixtures'


class EvidenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_stuck_writer_is_abandoned_with_bounded_close_and_no_executor_shutdown_wait(self):
        with tempfile.TemporaryDirectory() as home:
            code = f'''
import asyncio,sys,threading
sys.path.insert(0,{str(ROOT/'tools/voice')!r})
from evidence import VoiceEvidence
async def main():
    journal=VoiceEvidence({home!r},'blocked',close_timeout=.03)
    blocked=threading.Event()
    journal._append=lambda row:blocked.wait()
    journal.start()
    await asyncio.sleep(.01)
    await journal.close()
    assert journal.worker.done() and journal.writer.daemon
asyncio.run(main())
print('closed')
'''
            process=await asyncio.create_subprocess_exec(sys.executable,'-c',code,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
            try:
                stdout,stderr=await asyncio.wait_for(process.communicate(),2)
                self.assertEqual(process.returncode,0,stderr.decode())
                self.assertEqual(stdout.decode().strip(),'closed')
            finally:
                if process.returncode is None: process.kill();await process.wait()

    async def test_broken_diagnostic_logger_does_not_kill_worker_or_hang_close(self):
        with tempfile.TemporaryDirectory() as home:
            def broken_log(_):raise BrokenPipeError('closed terminal')
            journal=VoiceEvidence(home,'broken-log',close_timeout=.05,log=broken_log)
            with patch.object(journal,'_append',side_effect=OSError('disk unavailable')):
                journal.start()
                for _ in range(5):journal.emit({'event':'turn_started'})
                await asyncio.wait_for(journal.close(),.3)
            self.assertTrue(journal.worker.done())
            self.assertIsNone(journal.worker.exception())
            self.assertTrue(journal.warned)

    async def test_concurrent_clears_keep_the_generation_that_was_actually_acknowledged(self):
        class HoldingAudio(Audio):
            def __init__(self):super().__init__();self.pending={}
            async def clear(self,generation):
                self.pending[generation]=asyncio.get_running_loop().create_future()
                await self.pending[generation]
        events=[];audio=HoldingAudio()
        controller=Conversation(None,audio,'unused',on_evidence=events.append,log=lambda _:None)
        controller.response_record={'generation':0,'requestId':'request-a','status':'running'}
        first=asyncio.create_task(controller.invalidate('stop'))
        await asyncio.sleep(0)
        second=asyncio.create_task(controller.invalidate('replacement'))
        await asyncio.sleep(0)
        self.assertEqual(sorted(audio.pending),[1,2])
        audio.pending[1].set_result(None);await first
        self.assertEqual(next(e for e in events if e['event']=='output_cleared')['nativeGeneration'],1)
        self.assertFalse(second.done())
        audio.pending[2].set_result(None);await second

    async def test_failed_native_clear_is_not_reported_as_a_clear_ack(self):
        class BrokenAudio(Audio):
            async def clear(self,generation):
                if generation>1:raise OSError('native connection closed')
                await super().clear(generation)
        class FailedAgent:
            async def stream(self,text):
                if False:yield None
                raise ConnectionError('model unavailable')
        events=[]
        controller=Conversation(FailedAgent(),BrokenAudio(),'unused',on_evidence=events.append,log=lambda _:None)
        await controller.ask('fixture')
        await controller.wait_idle()
        self.assertEqual(controller.records[-1]['status'],'failed')
        self.assertNotIn('local_clear_ack_at',controller.records[-1])
        self.assertFalse(any(row['event']=='output_cleared' for row in events))
        with self.assertRaises(OSError):await controller.close()

    async def test_whitelist_private_files_bounded_rotation_and_restart(self):
        with tempfile.TemporaryDirectory() as home:
            journal=VoiceEvidence(home,'instance-1',max_bytes=700)
            journal.start()
            for i in range(12):
                journal.emit({'event':'request_bound','requestId':'request-'+str(i),'generation':i,
                              'text':'PRIVATE TEXT','pcm':'PRIVATE AUDIO','device':'PRIVATE DEVICE'})
            await journal.close()
            second=VoiceEvidence(home,'instance-2',max_bytes=700)
            second.start();await second.close()
            paths=list(Path(home).glob('voice-evidence*.jsonl'))
            self.assertEqual(len(paths),2)
            for path in paths:
                self.assertLessEqual(path.stat().st_size,700)
                self.assertEqual(path.stat().st_mode & 0o777,0o600)
                self.assertNotIn('PRIVATE',path.read_text())
            latest=json.loads((Path(home)/'voice-evidence.jsonl').read_text().splitlines()[-1])
            self.assertEqual(latest['voiceInstanceId'],'instance-2')

    async def test_overflow_is_explicit_and_disk_failure_does_not_fail_voice_callback(self):
        with tempfile.TemporaryDirectory() as home:
            journal=VoiceEvidence(home,'bounded',queue_size=1)
            journal.start()
            for _ in range(10):journal.emit({'event':'turn_started'})
            await journal.queue.join()
            journal.emit({'event':'turn_settled','status':'complete'})
            await journal.queue.join();await journal.close()
            rows=[json.loads(line) for line in journal.path.read_text().splitlines()]
            self.assertTrue(any(row['droppedBefore']>=10 for row in rows))
            warnings=[]
            bad=VoiceEvidence(home,'failed',log=warnings.append)
            with patch.object(bad,'_append',side_effect=OSError('secret filesystem detail')):
                bad.start();bad.emit({'event':'turn_started'});await bad.close()
            self.assertEqual(len(warnings),1)
            self.assertNotIn('secret',warnings[0])


class ProjectVoicePipelineTests(unittest.IsolatedAsyncioTestCase):
    """Real Node project/lease + UiBridge + NativeAudio IPC + Swift queue.

    Only model/TTS/ASR text and native playback callbacks are fixtures. This is
    protocol evidence, not microphone, Bluetooth, echo cancellation or listening QA.
    """
    @classmethod
    def setUpClass(cls):
        cls.node=shutil.which('node')
        if Path('/opt/homebrew/opt/node@24/bin/node').exists():cls.node='/opt/homebrew/opt/node@24/bin/node'
        if not cls.node or not shutil.which('xcrun'):
            raise unittest.SkipTest('Node 24 and Swift required for native protocol integration')
        cls.native_home=tempfile.TemporaryDirectory()
        cls.binary=Path(cls.native_home.name)/'playback-fixture'
        subprocess.run(['xcrun','swiftc',str(ROOT/'tools/voice/native/PlaybackQueue.swift'),
                        str(FIXTURES/'PlaybackFixture.swift'),'-o',str(cls.binary)],check=True,capture_output=True,timeout=60)

    @classmethod
    def tearDownClass(cls):cls.native_home.cleanup()

    async def asyncSetUp(self):
        self.home=tempfile.TemporaryDirectory()
        self.host=await asyncio.create_subprocess_exec(self.node,str(FIXTURES/'project-voice-host.mjs'),
            stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        self.lock=asyncio.Lock();self.seq=0
        async def api(path,body,**kwargs):
            async with self.lock:
                self.seq+=1
                self.host.stdin.write((json.dumps({'id':self.seq,'path':path,'body':body})+'\n').encode())
                await self.host.stdin.drain()
                line=await self.host.stdout.readline()
                if not line:raise RuntimeError((await self.host.stderr.read()).decode())
                result=json.loads(line)
                if 'error' in result:raise ValueError(result['error'])
                return result['result']
        self.api=api
        self.agent=BotAgent(api=api)
        self.audio=NativeAudio()
        async def binary():return self.binary
        with patch('audio_bridge.build_helper',binary):await self.audio.start()
        async def tts(*args,**kwargs):
            yield b'\0\0'*100
            yield b'\0\0'*100
        self.logs=[]
        self.controller=Conversation(self.agent,self.audio,'unused',synthesize=tts,log=self.logs.append)
        self.bridge=UiBridge(api,interval=.01)
        self.evidence=VoiceEvidence(self.home.name,self.bridge.instance_id)
        self.evidence.start()
        self.controller.on_evidence=self.audio.on_evidence=self.evidence.emit
        self.controller.on_state=self.bridge.publish
        self.audio.on_state=self.controller.notify
        self.bridge.publish(self.controller.voice_state())
        await self.bridge.connect()
        self.commands=asyncio.Queue()
        self.control_results=[]
        self.jobs=[asyncio.create_task(self.bridge.run(self.commands)),asyncio.create_task(self.controls())]
        self.initial=await self.api('/snapshot',{})

    async def asyncTearDown(self):
        for job in self.jobs:job.cancel()
        await asyncio.gather(*self.jobs,return_exceptions=True)
        await self.controller.close();await self.audio.close();await self.agent.close()
        await self.bridge.close();await self.evidence.close()
        self.host.stdin.close();await self.host.stdin.wait_closed()
        await asyncio.wait_for(self.host.wait(),3)
        self.home.cleanup()

    async def controls(self):
        while True:
            command=await self.commands.get()
            valid=matches_control(command,self.controller,self.bridge.instance_id)
            self.controller.evidence('control_received',self.controller.response_record,
                                     controlId=command['id'],action=command['action'])
            if valid:await self.controller.control('/'+command['action'])
            status='applied' if valid else 'stale'
            self.bridge.ack(command,{'status':status})
            self.controller.evidence('control_settled',controlId=command['id'],action=command['action'],status=status)
            self.control_results.append(status)

    async def until(self,predicate):
        async with asyncio.timeout(3):
            while not predicate():await asyncio.sleep(.01)

    async def speech(self,text,ident):
        await self.controller.handle({'type':'start','id':ident,'epoch':self.controller.epoch})
        await self.controller.handle({'type':'final','id':ident,'epoch':self.controller.epoch,'text':text})

    async def playing(self):
        await self.until(lambda:self.audio.frames==200 and self.controller.response_record.get('agent_complete_at'))
        await self.audio.command('fixture_receipt')
        await self.until(lambda:bool(self.audio.playback_times))
        async with asyncio.timeout(3):
            while True:
                state=(await self.api('/snapshot',{}))['voice']
                if state['playback']=='playing' and state['requestId']==self.controller.response_record['requestId']:return
                await asyncio.sleep(.01)

    async def test_project_switch_and_barge_in_clear_playing_audio_without_replay(self):
        await self.speech('A 的方案',1);await self.playing()
        first=self.controller.response_record;generation=first['generation']
        self.assertIn('蓝色',first['text'])
        await self.api('/select',{'projectId':self.initial['b'],'id':'to-b'})
        await self.until(lambda:self.control_results==['applied'])
        await self.controller.wait_idle()
        self.assertEqual(first['status'],'interrupted')
        self.assertEqual(first['interruption'],'stop')
        self.assertEqual(self.audio.frames,0)
        self.assertGreater(self.audio.generation,generation)
        # A native callback already in flight cannot restore the cleared A audio.
        await self.audio.command('fixture_receipt')
        self.assertEqual(self.audio.played_segments,set())
        self.assertEqual(self.audio.playback,'idle')
        await self.speech('B 的方案',2);await self.playing()
        second=self.controller.response_record
        self.assertIn('橙色',second['text'])
        self.assertEqual(second['expected_project']['projectId'],self.initial['b'])
        await self.controller.handle({'type':'start','id':3,'epoch':self.controller.epoch})
        await self.controller.handle({'type':'evidence','id':3,'epoch':self.controller.epoch,'acoustic':{'strong_ms':600}})
        await self.controller.handle({'type':'partial','id':3,'epoch':self.controller.epoch,'text':'停一下'})
        self.assertEqual(second['status'],'interrupted')
        self.assertEqual(second['interruption'],'speech')
        self.assertEqual(self.audio.frames,0)
        await self.audio.command('fixture_receipt')
        self.assertEqual(self.audio.played_segments,set())
        await self.controller.control('/mute')
        await self.controller.wait_idle();await self.evidence.queue.join()
        rows=[json.loads(line) for line in self.evidence.path.read_text().splitlines()]
        self.assertTrue(any(r['event']=='native_playback_receipt' and r['accepted'] for r in rows))
        self.assertTrue(any(r['event']=='native_playback_receipt' and not r['accepted'] for r in rows))
        for record in [first,second]:
            cleared=next(r for r in rows if r['event']=='output_cleared' and r.get('requestId')==record['requestId'])
            self.assertTrue(any(r['event']=='native_clear_ack' and r['generation']==cleared['nativeGeneration']
                                and r['monotonic']<=cleared['monotonic'] for r in rows))
        self.assertTrue(all(r['droppedBefore']==0 for r in rows))
        accepted=(await self.api('/snapshot',{}))['accepted']
        self.assertEqual([r['projectId'] for r in accepted],[self.initial['a'],self.initial['b']])
        self.assertTrue(all(r['source']=='voice' for r in accepted))
        if output:=os.environ.get('OPENNOVA_VOICE_EVIDENCE_TEST_OUTPUT'):
            path=Path(output);path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(json.dumps({'passed':True,'acoustic_validation':False,
                'production':['ProjectService','VoiceChannel','UiBridge','Conversation','NativeAudio IPC','PlaybackQueue'],
                'fixtures':['model answer','ASR events','TTS PCM','native playback callbacks'],
                'accepted':accepted,'events':rows},ensure_ascii=False,indent=2))

    async def test_late_asr_reaches_real_admission_with_old_revision_and_never_runs_in_b(self):
        await self.controller.handle({'type':'start','id':1,'epoch':self.controller.epoch})
        capture=self.controller.inputs[1]['project_capture']
        await capture
        await self.api('/select',{'projectId':self.initial['b'],'id':'late-asr'})
        await self.controller.handle({'type':'final','id':1,'epoch':self.controller.epoch,'text':'修改 A 的资料'})
        await self.controller.wait_idle()
        self.assertEqual((await self.api('/snapshot',{}))['accepted'],[])
        self.assertEqual(self.audio.played_segments,set())
        self.assertEqual(self.controller.records[-1]['status'],'failed')
        self.assertTrue(any('说话期间当前项目已变化' in line for line in self.logs))

    async def test_late_stop_from_a_cannot_cancel_new_b_reply(self):
        await self.speech('A 的方案',1);await self.playing()
        a=self.controller.response_record
        stale={'id':'late-a-stop','action':'stop','voiceInstanceId':self.bridge.instance_id,
               'generation':a['generation'],'requestId':a['requestId']}
        await self.api('/select',{'projectId':self.initial['b'],'id':'late-stop-b'})
        await self.until(lambda:self.control_results==['applied'])
        await self.controller.wait_idle()
        await self.audio.command('fixture_receipt')
        await self.speech('B 的方案',2);await self.playing()
        b=self.controller.response_record;generation=self.controller.generation
        self.assertFalse(matches_control(stale,self.controller,self.bridge.instance_id))
        await self.commands.put(stale)
        await self.until(lambda:self.control_results==['applied','stale'])
        self.assertEqual(self.controller.generation,generation)
        self.assertEqual(b['status'],'running')
        self.assertEqual(self.audio.frames,100)
        self.assertEqual(self.audio.playback,'playing')
