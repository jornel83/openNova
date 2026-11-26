import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {mkdtempSync,writeFileSync,realpathSync,statSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createActiveDocumentTracker} from '../desktop/active-document.mjs';

function fixture(t,answer,options={}){
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),kill(){this.emit('close');}});
  const requests=createInterface({input:child.stdin});
  requests.on('line',line=>{
    const request=JSON.parse(line),reply=answer(request);
    if(reply)child.stdout.write(JSON.stringify({...reply,id:request.id})+'\n');
  });
  const tracker=createActiveDocumentTracker({port:18660,platform:'darwin',startHelper:()=>child,...options});
  if(options.ready!==false)child.stdout.write('{\"ready\":true}\n');
  t.after(()=>{tracker.close();requests.close();});
  return {child,tracker};
}

test('a verified desktop document is bound by path and exact Node stat identity; web origin stays local to the helper',async t=>{
  const temp=mkdtempSync(join(tmpdir(),'nova-window-'));t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const path=join(realpathSync(temp),'报告.pdf');writeFileSync(path,'test bytes');
  const {dev,ino,size,mtimeMs,ctimeMs}=statSync(path);
  let observedInode=ino;
  const {tracker}=fixture(t,({web,port})=>{
    assert.equal(web,true);assert.equal(port,18660);
    return {status:'available',app:'WPS',path,inode:String(observedInode),device:String(dev)};
  });
  assert.deepEqual(await tracker.capture({source:'web'}),{status:'available',app:'WPS',file:{name:'报告.pdf',path,ino,size,mtimeMs,ctimeMs}});
  observedInode+=1;
  assert.deepEqual(await tracker.capture({source:'web'}),{status:'unavailable',reason:'document_window_changed'});
});

test('denied, unsupported, ambiguous and unavailable observations never reuse a previous file',async t=>{
  const results=[{status:'permission_required',reason:'accessibility_required'},
    {status:'ambiguous',reason:'same_name_open_files'},{status:'unavailable',reason:'document_window_changed'},
    {status:'unsupported',reason:'not_a_local_file'}];
  const {tracker}=fixture(t,({web,id})=>{assert.equal(web,false);return results[id-1];});
  for(const expected of results)assert.deepEqual(await tracker.capture({source:'voice'}),expected);
  const unsupported=createActiveDocumentTracker({platform:'linux',startHelper:()=>assert.fail()});
  assert.equal((await unsupported.capture()).status,'unsupported');unsupported.close();
});

test('timed-out helper replies are discarded; pending capture closes without dangling requests',async t=>{
  const {tracker,child}=fixture(t,()=>null,{timeoutMs:25,ready:false});
  assert.equal((await tracker.capture()).reason,'desktop_observer_starting');
  child.stdout.write('{"ready":true}\n');
  assert.equal((await tracker.capture()).reason,'desktop_observer_timeout');
  const next=tracker.capture();assert.equal((await tracker.capture()).reason,'desktop_observer_busy');child.stdout.write('{"id":1,"status":"ambiguous"}\n');
  tracker.close();
  assert.equal((await next).reason,'desktop_observer_stopped');
  assert.equal((await tracker.capture()).reason,'desktop_observer_stopped');
});

test('Nova recognizes the Chrome for Testing bundle used by its chat window', {skip:process.platform!=='darwin'},()=>{
  const source=readFileSync(new URL('../../../tools/desktop/active-document.swift',import.meta.url),'utf8');
  const checks=`
precondition(browsers.contains("com.google.chrome.for.testing"))
precondition(!browsers.contains("com.google.chrome.for.testing.helper"))
`;
  const result=spawnSync('/usr/bin/swift',['-D','ACTIVE_DOCUMENT_TEST','-'],{input:source+checks,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
});

test('WPS compatibility matches only exact open filenames in the selected process and rejects duplicate names or identity changes',
  {skip:process.platform!=='darwin'},t=>{
    const temp=mkdtempSync(join(tmpdir(),'nova-window-native-'));t.after(()=>rmSync(temp,{recursive:true,force:true}));
    const source=readFileSync(new URL('../../../tools/desktop/active-document.swift',import.meta.url),'utf8');
    const checks=`
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory:true).resolvingSymlinksInPath()
let fm = FileManager.default
let dirs = ["a", "b"].map { root.appendingPathComponent($0) }
for dir in dirs { try fm.createDirectory(at:dir, withIntermediateDirectories:true) }
let files = dirs.map { $0.appendingPathComponent("报告.pdf") }
for file in files { try Data("test".utf8).write(to:file) }
func expect(_ reason:String, _ action:() throws -> LocalFile) {
    do { _ = try action(); fatalError("unexpectedly selected a file") }
    catch let issue as Issue { precondition(issue.reason == reason, "wrong reason: " + issue.reason) }
    catch { fatalError("unexpected error") }
}
func selected(_ name:String = "报告.pdf") throws -> LocalFile { try wpsFile(pid:getpid(), title:name) }
let first = try FileHandle(forReadingFrom:files[0])
let firstFile = try selected()
precondition(firstFile.path == files[0].path)
expect("no_document_path"){try selected("missing.pdf")}
let second = try FileHandle(forReadingFrom:files[1])
expect("same_name_open_files"){try selected()}
try second.close()
try first.close()
expect("no_document_path"){try selected()}
`;
    const result=spawnSync('/usr/bin/swift',['-D','ACTIVE_DOCUMENT_TEST','-',temp],{input:source+checks,encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr);
  });
