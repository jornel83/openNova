import {setTimeout} from 'node:timers/promises';
export const name='opennova-probe-tool';
export const inject=['tools'];
export function apply(ctx) {
  ctx.tools.register({name:'lookup_probe_value',description:'Read the probe value. wait=true delays the lookup.',
    parameters:{type:'object',properties:{wait:{type:'boolean'}},additionalProperties:false},
    output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},
    async execute(args,exec) {
      if(args.wait)await setTimeout(30000,undefined,{signal:exec.signal});
      return 'opennova-web-probe-ok';
    }});
}
