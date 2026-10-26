/** All experiment writes enter through the authenticated bridge, not the native UI. */
export function withoutNativeChannel(ctx) {
  const connection=new Proxy(ctx.connection,{get(target,key){
    if(key==='fetch')return {register:()=>()=>{}};
    return Reflect.get(target,key,target);
  }});
  return new Proxy(ctx,{get(target,key){return key==='connection'?connection:Reflect.get(target,key,target);}});
}

/** Acquire disposers immediately, including when startup fails before listen(). */
export function ownResources(ctx) {
  const disposers=[];let closing,closed=false;
  const close=()=>{closed=true;return closing??=Promise.resolve().then(async()=>{
    for(const dispose of disposers.reverse())await dispose();
  });};
  ctx.effect(()=>close);
  return {add:fn=>{if(closed){void Promise.resolve().then(fn).catch(()=>{});}else disposers.push(fn);},close,assertOpen(){if(closed)throw Error('host_disposed');}};
}

/** Text only: after resolving the real Harness agent, admission is synchronous.
 * This avoids the upstream attachment admission await, which cannot be cancelled.
 */
export async function admitText({active,resolve,message}) {
  const agent=await resolve();
  active.cancel=()=>{agent.cancel({kind:'user'});return agent.whenIdle();};
  if(active.cancelled)return;
  if(agent.status==='running')throw Error('bot_busy');
  agent.followup(message);
  return agent;
}
