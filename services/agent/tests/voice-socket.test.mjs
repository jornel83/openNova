import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnection} from 'node:net';
import {once} from 'node:events';
import {dirname} from 'node:path';
import {statSync,existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {voiceSocket} from '../voice-socket.mjs';

test('private socket handshakes, acknowledges control and removes its directory on close', async () => {
  const events=[];
  const control=await voiceSocket(event=>events.push(event));
  const peer=createConnection(control.path);
  let lines;
  try {
    assert.equal(statSync(dirname(control.path)).mode & 0o777,0o700);
    await once(peer,'connect');
    lines=createInterface({input:peer});
    lines.on('line',line=>{
      const request=JSON.parse(line);
      peer.write(JSON.stringify({type:'ack',rpc:request.rpc})+'\n');
    });
    peer.write('{"type":"control_ready"}\n');
    await control.ready();
    await control.command('arm',1,'session-one');
    peer.write('{"type":"delta","id":1,"text":"你好"}\n');
    // A following RPC acknowledgement is a serialization barrier for the delta.
    await control.command('cancel',1);
    assert.equal(events[0].text,'你好');
  } finally {
    lines?.close(); peer.destroy();control.close();
  }
  assert.equal(existsSync(dirname(control.path)),false);
});

test('disconnect rejects an outstanding command without waiting for its timeout',async()=>{
  const control=await voiceSocket(()=>{});
  const peer=createConnection(control.path);
  try {
    await once(peer,'connect');
    peer.write('{"type":"control_ready"}\n');
    await control.ready();
    const request=control.command('cancel',1);
    peer.destroy();
    await assert.rejects(request,/voice_control_closed/);
  } finally {peer.destroy();control.close();}
});
