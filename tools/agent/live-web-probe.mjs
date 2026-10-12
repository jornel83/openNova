import {AgentClient} from './client.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
/** fetchOnly is an explicit probe fixture; its unused dummy Exa key never enables a real search. */
export async function liveWebProbe({fetchOnly=false}={}) {
  if(fetchOnly)process.env.EXA_API_KEY='synthetic-unused-fetch-probe';
  const events=[],report={kind:fetchOnly?'live-public-fetch':'live-web-search',startedAt:new Date().toISOString(),turns:[]};
  const client=new AgentClient({web:true,onEvent:e=>{if(e.type==='status')events.push(e);}});
  try {
    await client.start();
    let text=fetchOnly?'只使用 web_fetch 读取 https://example.com ，简短说明网页内容并附上来源链接。不要搜索。':'联网搜索 DeepSeek Harness 官方 GitHub 项目，说明它是什么并提供来源。';
    for(let i=0;i<3;i++) {
      events.length=0;const r=await client.ask(text);
      report.turns.push({text:r.text,sources:r.sources,statuses:[...events],elapsedMs:r.elapsed_ms});
      if(r.type!=='reply'||!r.sources?.length)throw Error('probe_sources_missing');
      if(i===0&&!events.some(e=>e.phase===(fetchOnly?'reading':'searching')))throw Error('probe_tool_not_called');
      text=i===0?`请使用 web_fetch 读取 ${r.sources[0].url} ，给一句基于正文的总结并引用链接。只用读取工具。`:'刚才的判断来自哪个网页？再次给出该来源链接。不必再检索。';
    }
    if(fetchOnly&&report.turns.some(t=>t.statuses.some(e=>e.phase==='searching')))throw Error('unexpected_search_in_fetch_probe');
    report.passed=true;
  }catch(e){report.error=/^[a-z_]+$/.test(e.message)?e.message:'probe_failed';process.exitCode=1;}
  finally{await client.close();}
  const dir=fileURLToPath(new URL('../../output/agent/web-verification/',import.meta.url));mkdirSync(dir,{recursive:true});
  const path=dir+`web-${Date.now()}.json`;writeFileSync(path,JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,evidenceFile:path},null,2));return report;
}
