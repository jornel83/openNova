import {verifySkillSnapshot} from './bundle.mjs';
/** Register immutable OpenNova skill snapshots with the bundled Harness registry. */
export const name='opennova-task-skills';
export const inject=['skills'];
export function apply(ctx,config){
  for(const skill of config.skills??[]){verifySkillSnapshot(skill);ctx.effect(()=>ctx.skills.register({
    name:skill.name,description:skill.description,content:skill.content,
    source:'opennova',resourceBase:skill.resourceBase,
    invocation:{modelInvocable:skill.invocation?.model!==false,userInvocable:skill.invocation?.user!==false},
    metadata:{version:skill.version},
  }));}
}

/** Publish only the chief's currently enabled skills; employee Runs use snapshots. */
export function installSkillCatalog(ctx,{store,team,events}){
  const registry=ctx.get('skills');if(!registry)throw Error('skill_registry_unavailable');
  let invalidate=()=>{};
  ctx.effect(()=>registry.registerProvider(control=>{
    invalidate=control.invalidate;
    const skills=()=>store.snapshot({assignedBotId:team.chiefId});
    return {name:'opennova',
      list:async()=>skills().map(skill=>({name:skill.name,description:skill.description,source:'opennova',provider:'opennova',
        invocation:{modelInvocable:skill.invocation?.model!==false,userInvocable:skill.invocation?.user!==false},resourceBase:skill.resourceBase,rank:0,locator:{name:skill.name,version:skill.version}})),
      get:async candidate=>{
        const skill=skills().find(item=>item.name===candidate.name&&item.version===candidate.locator.version);
        return skill?{...candidate,content:skill.content,metadata:{version:skill.version}}:undefined;
      },
    };
  }));
  ctx.effect(()=>events.subscribe(events.snapshot(()=>null).cursor,event=>{if(event.type.startsWith('skill')||event.type==='team.updated')invalidate();}));
}
