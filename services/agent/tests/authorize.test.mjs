import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeAccount,parseAuthorizationArgs} from '../authorize.mjs';
const old={status:'connected',sharing:true,profileId:'old',profileLabel:'Original'};
test('default login leaves a connected account untouched; malformed switch arguments fail before touching credentials',async()=>{
 let calls=0;const clientFactory=async()=>({getSession:async()=>old,signIn:async()=>{calls++;}});
 assert.equal(await authorizeAccount([],{clientFactory,log:()=>{}}),old);assert.equal(calls,0);
 for(const args of [['--new'],['--select-account'],['--select-account','../escape'],['--add-account','--list-accounts']])assert.throws(()=>parseAuthorizationArgs(args),/invalid_authorization_arguments/);
});
test('adding an account starts explicit new-profile OAuth, keeps the old profile, and only redirects to official sign-in',async()=>{
 let received,login;const newer={...old,profileId:'new',profileLabel:'Second'};
 const clientFactory=async({openBrowser})=>({signIn:async options=>{received=options;openBrowser('https://auth.openai.com/oauth/authorize?state=fixture');
  const response=await fetch(login,{redirect:'manual'});assert.equal(response.status,302);assert.equal(new URL(response.headers.get('location')).origin,'https://auth.openai.com');assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(login,{method:'POST'})).status,403);return newer;
 }});
 const result=await authorizeAccount(['--add-account'],{clientFactory,port:0,log:message=>{const m=message.match(/http:\/\/127\.0\.0\.1:\d+\/login/);if(m)login=m[0];}});
 assert.deepEqual(received,{newProfile:true});assert.equal(result,newer);
 await assert.rejects(authorizeAccount(['--add-account'],{port:0,log:()=>{},clientFactory:async({openBrowser})=>({signIn:async()=>{openBrowser('https://example.com/login');}})}),/unexpected_auth_origin/);
});
test('cancelled authorization does not disconnect the old profile; pending registration resumes without selecting early',async()=>{
 const selected=[];let received;
 const clientFactory=async()=>({listProfiles:async()=>[{id:'pending',pending:true,status:'disconnected'}],selectProfile:async id=>selected.push(id),signIn:async options=>{received=options;throw Error('cancelled');}});
 await assert.rejects(authorizeAccount(['--select-account','pending'],{clientFactory,port:0,log:()=>{}}),/cancelled/);
 assert.deepEqual(received,{profileId:'pending'});assert.deepEqual(selected,[]);
});
test('selecting an existing connected account reuses its registration; listing never exposes extra credential fields',async()=>{
 let chosen,output;const profile={...old,id:'old',label:'Original',credentials:'DO_NOT_LOG'};
 const clientFactory=async()=>({getSession:async()=>old,listProfiles:async()=>[profile],selectProfile:async id=>{chosen=id;return old;}});
 assert.equal(await authorizeAccount(['--select-account','old'],{clientFactory,log:()=>{}}),old);assert.equal(chosen,'old');
 await authorizeAccount(['--list-accounts'],{clientFactory,log:text=>output=text});assert.doesNotMatch(output,/DO_NOT_LOG|credentials/);assert.equal(JSON.parse(output)[0].active,true);
});
