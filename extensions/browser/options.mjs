const $=id=>document.getElementById(id),show=value=>{$('result').textContent=typeof value==='string'?value:JSON.stringify(value,null,2);};
const send=async(message)=>{const r=await chrome.runtime.sendMessage(message);if(r?.error)throw Error(r.error);show(r);return r;};
for(const [id,action] of Object.entries({
 pair:async()=>{await send({type:'pair',base:$('base').value,code:$('code').value.trim()});$('code').value='';},
 reconnect:()=>send({type:'reconnect'}),status:()=>send({type:'status'}),
 grant:async()=>show({permissionGranted:await chrome.permissions.request({origins:['http://*/*','https://*/*']})}),
 windows:()=>send({type:'local-command',method:'windows.ensure',args:{}}),
 read:()=>send({type:'local-command',method:'read',args:{}}),
}))$(id).addEventListener('click',()=>Promise.resolve(action()).catch(e=>show(e.message)));
const current=await chrome.runtime.sendMessage({type:'status'});if(current.base)$('base').value=current.base;show(current);
