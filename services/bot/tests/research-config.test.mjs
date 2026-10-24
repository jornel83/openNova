import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadResearchConfig,publicResearchConfig,researchTools} from '../research/config.mjs';
import {researchPlugins} from '../research/plugins.mjs';
import {ALLOWED_TOOLS} from '../policy.mjs';
function fixture(t,web={enabled:true,provider:'deepseek'}) {
 const dir=mkdtempSync(join(tmpdir(),'nova-research-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const configFile=join(dir,'config.json'),secretsFile=join(dir,'secrets.json');
 writeFileSync(configFile,JSON.stringify({web}));writeFileSync(secretsFile,JSON.stringify({web:{deepseek_api_key:'test-only-key'}}));
 return {configFile,secretsFile,env:{}};
}
test('enabled_bot_registers_search_without_losing_project_tools',t=>{
 const config=loadResearchConfig(fixture(t)),names=researchTools(ALLOWED_TOOLS,config);
 for(const name of ['web_search','read','write','bash','browser_open'])assert.ok(names.includes(name));
 const plugins=researchPlugins({harnessRoot:'/test/harness',enabled:config.available});
 assert.equal(plugins.find(p=>p.id==='web').config.searchProvider,'deepseek-official');
 assert.equal(plugins.find(p=>p.id==='web-search-deepseek').config.maxUses,1);
 assert.deepEqual(researchPlugins({enabled:false}),[]);
});
test('missing_key_only_disables_research',t=>{
 const opts=fixture(t);writeFileSync(opts.secretsFile,'{}');const config=loadResearchConfig(opts);
 assert.equal(config.available,false);assert.equal(config.reason,'deepseek_api_key_missing');
 assert.ok(researchTools(ALLOWED_TOOLS,config).includes('bash'));assert.ok(!researchTools(ALLOWED_TOOLS,config).includes('web_search'));
});
test('child_env_exposes_only_selected_credential',t=>{
 const config=loadResearchConfig({...fixture(t),env:{DEEPSEEK_API_KEY:'test-env-key',EXA_API_KEY:'do-not-pass'}});
 assert.deepEqual(config.childEnv,{DEEPSEEK_API_KEY:'test-env-key'});
 assert.ok(!JSON.stringify(publicResearchConfig(config)).includes('test-env-key'));
});
test('disabled mode does not read secrets and invalid provider degrades explicitly',t=>{
 const opts=fixture(t,{enabled:false});writeFileSync(opts.secretsFile,'broken');assert.equal(loadResearchConfig(opts).available,false);
 assert.equal(loadResearchConfig(fixture(t,{enabled:true,provider:'exa'})).reason,'research_provider_unsupported');
});
