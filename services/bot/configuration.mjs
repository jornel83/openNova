/** Product composition shared by the launcher and offline runtime smoke tests. */
import {join} from 'node:path';
import {ROOT} from '../runtime/sources.mjs';
import {ALLOWED_TOOLS,MODEL_BUDGET} from './policy.mjs';
import {PROJECT_PLUGINS} from './project.mjs';
export function runtimePatch({bot:b,agent:s,webAssets,root=ROOT}) {
return [
  ...['llm-deepseek','llm-deepseek-account','llm-pi-ai','session-title-llm','llm-retry','hmr'].map(id=>({id,disabled:true})),
  {id:'agent-default-model',config:{provider:'opennova-chatgpt',model:'gpt-6.1-sol'}},
  {id:'bash-sandbox',config:{timeoutMs:120000}},
  {id:'preset-standard',config:{id:'standard',order:1,plugins:PROJECT_PLUGINS}},
  {insert:[
    {id:'opennova-chatgpt',name:join(root,'services/agent/provider.mjs'),config:{harnessRoot:s.harnessRoot,enableTools:true,allowedTools:ALLOWED_TOOLS,modelBudget:MODEL_BUDGET,requestFilter:join(root,'services/bot/model-policy.mjs'),retiredMemoryPath:join(b.home,'retired.json')}},
    {id:'opennova-bot',name:join(root,'services/bot/host.mjs'),config:{...b,harnessRoot:s.harnessRoot,webAssets}},
  ]},
];
}
