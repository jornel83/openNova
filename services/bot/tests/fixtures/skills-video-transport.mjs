/** Offline remote-video fixture: durable counters and real local FFmpeg artifacts. */
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createVideoTransport} from '../../skills/video.mjs';
import {ROOT} from '../../../runtime/sources.mjs';
export function createVideoAdapter({home}){
  const statePath=join(home,'video-fixture.json'),real=createVideoTransport({root:ROOT,python:'python3.11'});
  const read=()=>existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{posts:0,queries:0,downloads:0};
  const save=state=>writeFileSync(statePath,JSON.stringify(state));
  return {credential:()=> 'offline-fixture-key',pollMs:100,transport:async call=>{
    if(['video_validate','video_edit'].includes(call.name))return real(call);
    const state=read(),directory=call.args.output_dir;
    if(call.name==='video_submit'){
      state.posts++;save(state);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'task.json'),JSON.stringify({id:'offline-remote-1',status:'submitted'}));
      return {task_id:'offline-remote-1',status:'submitted',output_dir:directory};
    }
    if(call.args.task_id!=='offline-remote-1')throw Error('fixture_foreign_video');
    if(call.name==='video_status'){state.queries++;save(state);return {task_id:'offline-remote-1',status:existsSync(join(home,'video-ready'))?'succeeded':'running'};}
    if(call.name==='video_download'){
      if(!existsSync(join(home,'video-ready')))throw Error('fixture_video_not_ready');state.downloads++;save(state);
      const filename=call.args.filename??'video.mp4';if(basename(filename)!==filename)throw Error('fixture_invalid_filename');
      const path=join(directory,filename),result=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=24','-t','0.5','-c:v','libx264',path],{encoding:'utf8'});
      if(result.status!==0)throw Error('fixture_local_video_export_failed');return {task_id:'offline-remote-1',status:'succeeded',path,size_bytes:readFileSync(path).length};
    }
    throw Error('fixture_unknown_video_tool');
  }};
}
