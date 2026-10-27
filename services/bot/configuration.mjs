/** Product composition shared by the launcher and offline runtime smoke tests. */
import {join} from 'node:path';
import {ROOT} from '../runtime/sources.mjs';
import {ALLOWED_TOOLS,MODEL_BUDGET} from './policy.mjs';
import {publicResearchConfig,researchTools} from './research/config.mjs';
import {researchPlugins} from './research/plugins.mjs';
import {PROJECT_PLUGINS} from './project.mjs';
export function runtimePatch({bot:b,agent:s,webAssets,root=ROOT,desktop=false,research={}}) {
return [
  ...['llm-deepseek','llm-deepseek-account','llm-pi-ai','session-title-llm','hmr'].map(id=>({id,disabled:true})),
  {id:'llm-retry',disabled:false},
  {id:'agent-default-model',config:{provider:'opennova-chatgpt',model:'gpt-6.1-sol'}},
  {id:'bash-sandbox',config:{timeoutMs:120000}},
  {id:'preset-standard',config:{id:'standard',order:1,plugins:PROJECT_PLUGINS}},
  {insert:[
    ...researchPlugins({harnessRoot:s.harnessRoot,enabled:research.httpAvailable,searchAvailable:research.available,mode:research.mode,limits:research.limits}),
    {id:'opennova-chatgpt',name:join(root,'services/agent/provider.mjs'),config:{harnessRoot:s.harnessRoot,enableTools:true,allowedTools:researchTools(ALLOWED_TOOLS,research),modelBudget:MODEL_BUDGET,requestFilter:join(root,'services/bot/model-policy.mjs'),retiredMemoryPath:join(b.home,'retired.json')}},
    {id:'opennova-bot',name:join(root,'services/bot/host.mjs'),config:{...b,research:publicResearchConfig(research),harnessRoot:s.harnessRoot,webAssets,desktop}},
  ]},
];
}
