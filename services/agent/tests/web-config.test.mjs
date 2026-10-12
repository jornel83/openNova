import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {loadWebConfig,childEnvironment} from '../web-config.mjs';
test('web defaults off and credentials are scrubbed except explicit Exa opt-in',()=>{
 const c=loadWebConfig({env:{},configFile:'/missing',secretsFile:'/missing'});assert.equal(c.enabled,false);
 assert.throws(()=>loadWebConfig({enabled:true,env:{},configFile:'/missing',secretsFile:'/missing'}),/web_api_key_missing/);
 const env={EXA_API_KEY:'secret-test',DOUBAO_API_KEY:'private-test',OPENAI_API_KEY:'private-test',PATH:'/bin'};
 assert.equal(childEnvironment(env,c).EXA_API_KEY,undefined);
 const web=loadWebConfig({enabled:true,env,configFile:'/missing',secretsFile:'/missing'});
 assert.deepEqual(childEnvironment(env,web),{PATH:'/bin',EXA_API_KEY:'secret-test'});
});
test('local key is used only without env override; invalid config fails',()=>{
 const d=mkdtempSync(join(tmpdir(),'web-config-'));try{
 const configFile=join(d,'voice.json'),secretsFile=join(d,'secrets.json');
 writeFileSync(configFile,JSON.stringify({web:{provider:'exa'}}));writeFileSync(secretsFile,JSON.stringify({web:{exa_api_key:'test-file'}}));
 assert.equal(loadWebConfig({enabled:true,env:{},configFile,secretsFile}).apiKey,'test-file');
 assert.equal(loadWebConfig({enabled:true,env:{EXA_API_KEY:'test-env'},configFile,secretsFile}).apiKey,'test-env');
 for(const web of [{provider:'other'},{enabled:'yes'},{limits:{searchCalls:100}},{limits:{fetchMs:0}},{limits:{bogus:1}}]){
 writeFileSync(configFile,JSON.stringify({web}));assert.throws(()=>loadWebConfig({env:{},configFile,secretsFile}),/invalid_web_configuration/);
 }
 }finally{rmSync(d,{recursive:true,force:true});}
});
