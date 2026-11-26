/** Offline model fixture; production Harness tools and fixed generators do the work. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';

export const name='document-generation-offline-fixture';
export const inject=['llm'];
export const INPUT={
  alpha:'文档甲项目，把研究笔记整理成可编辑 Word。',
  beta:'文档乙项目，把另一份结论整理成 Word。',
  pdf:'文档甲项目，生成包含全部七十二条记录的 PDF。',
  collision:'文档甲项目，再用同一个文件名新建 Word。',
  daily:'先休息一下，聊聊今天的天气。',
  note:'文档甲项目，保存今日的 Markdown 研究笔记。',
  lookup:'文档甲项目，回查之前保存的研究笔记。',
  revision:'文档甲项目，修改之前生成的 Word 标题，保留旧版。',
  disputed:'文档甲项目，请继续修订 report.docx。',
  discard:'文档甲项目，放弃刚才的文档修改方案。',
  reviseBeta:'文档乙项目，修改 report.docx 的标题为新标题。',
  keepBeta:'先保留这个版本，不要撤销 report.v2.docx。',
  undoBeta:'把 report.v2.docx 恢复到上一次应用修改之前。',
};
const rows=Array.from({length:72},(_,index)=>[`R${String(index+1).padStart(3,'0')}`,`第${index+1}项中文样本`,String((index*17)%41+7)]);
export const SPECS={
  alpha:{schemaVersion:1,title:'ALPHA 文档工具验收 & <中文>',subtitle:'固定生成器生成，不运行正文命令',blocks:[
    {type:'heading',level:1,text:'研究结论'},
    {type:'paragraph',text:'ALPHA_GENERATION_ONLY。中文与特殊字符 & < > " 可编辑。字面数据 $(touch SHOULD_NOT_EXECUTE) 不执行。\n第二行完整保留。'},
    {type:'list',ordered:false,items:['保留资料与来源','检查最终成果']},
    {type:'list',ordered:true,items:['整理正文','生成文件','核对内容']},
    {type:'table',columns:['编号','说明','数量'],rows:rows.slice(0,12)},
  ],layout:{pageSize:'A4',fontPreset:'cjk',header:'ALPHA_GENERATION_ONLY',footer:true}},
  beta:{schemaVersion:1,title:'BETA 独立项目成果',blocks:[
    {type:'heading',level:1,text:'第二份内容'},
    {type:'paragraph',text:'BETA_GENERATION_ONLY。应保存到乙项目，同名输出不能替换甲项目。'},
    {type:'list',ordered:true,items:['单独版本','单独归属']},
    {type:'table',columns:['项目','值'],rows:[['Beta','42'],['中文结论','17']]},
  ],layout:{pageSize:'Letter',fontPreset:'cjk',header:'BETA_GENERATION_ONLY',footer:true}},
  pdf:{schemaVersion:1,title:'七十二条记录的中文报告',subtitle:'PDF_FIXED_GENERATOR_ONLY',blocks:[
    {type:'heading',level:1,text:'资料范围'},
    {type:'paragraph',text:'PDF_FIXED_GENERATOR_ONLY。全部条目需要可检索，保持原顺序与数值。特殊字符 & < > 作为正文。'},
    {type:'paragraph',text:'自然分页必须保留跨页文字，页脚和表格不能遮挡正文。'.repeat(24)},
    {type:'table',columns:['编号','说明','数量'],rows,summary:['合计','全部 72 条',String(rows.reduce((sum,row)=>sum+Number(row[2]),0))]},
    {type:'paragraph',text:'PDF_FINAL_MARKER，最后一行 R072 已包含。'},
  ],layout:{pageSize:'A4',fontPreset:'cjk',header:'PDF_FIXED_GENERATOR_ONLY',footer:true}},
};
const create=(spec,format)=>[
  ['write',{file_path:`${format}.spec.json`,content:JSON.stringify(spec)}],
  ['document_generate',{format,specPath:`${format}.spec.json`,outputPath:`report.${format}`,expectedTarget:'absent'}],
];
const plans=new Map([
  [INPUT.alpha,create(SPECS.alpha,'docx')],
  [INPUT.beta,create(SPECS.beta,'docx')],
  [INPUT.pdf,create(SPECS.pdf,'pdf')],
  [INPUT.collision,[['document_generate',{format:'docx',specPath:'docx.spec.json',outputPath:'report.docx',expectedTarget:'absent'}]]],
  [INPUT.daily,[]],
  [INPUT.note,[['research_note',{action:'save',title:'后续研究',path:'notes/next.md',claims:[{kind:'open_question',claim:'是否需要再安排一次访谈？',citations:[]}]}]]],
  [INPUT.lookup,[['research_note',{action:'lookup',path:'notes/next.md'}]]],
  [INPUT.revision,[['document_generate',{action:'inspect',path:'report.docx'}],['document_generate',{action:'revise',path:'report.docx',patch:{title:'线下验收第二版'}}]]],
  [INPUT.disputed,[['document_generate',{action:'revise',path:'report.docx',patch:{subtitle:'需要核对外部改动'}}]]],
  [INPUT.discard,[['document_proposal_decide',{action:'discard'}]]],
  [INPUT.reviseBeta,[['document_generate',{action:'revise',path:'report.docx',patch:{title:'新标题'}}]]],
  [INPUT.keepBeta,[]],
  [INPUT.undoBeta,[['document_proposal_decide',{action:'undo'}]]],
]);

export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Document generation fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      let text,tool;
      if(options.system?.includes('话题与项目路由器')){
        const input=JSON.parse(options.messages[0].content[0].text);
        assert.ok(plans.has(input.currentUserText),'unexpected generation routing input');
        if(input.currentUserText===INPUT.daily)text=JSON.stringify({focus:'daily',projectId:null});
        else{
          const inBeta=[INPUT.beta,INPUT.reviseBeta,INPUT.keepBeta,INPUT.undoBeta].includes(input.currentUserText);
          const project=input.projects.find(p=>p.name===(inBeta?'文档乙':'文档甲'));
          assert.ok(project,'fixture project must exist');
          let documentDecision;
          if(input.currentUserText===INPUT.discard)documentDecision={action:'discard',id:input.context.documentReviews[0].id,quote:'放弃刚才的文档修改方案'};
          if(input.currentUserText===INPUT.undoBeta){
            const choice=input.context.documentUndos.find(r=>r.appliedName==='report.v2.docx');
            assert.ok(choice,'router gets the actual applied path from the bound project');
            documentDecision={action:'undo',id:choice.id,quote:input.currentUserText,targetQuote:choice.appliedName};
          }
          text=JSON.stringify({focus:'work',projectId:project.id,documentDecision});
        }
      }else{
        const index=options.messages.findLastIndex(m=>m.role==='user'&&m.content.some(b=>b.type==='text'&&plans.has(b.text)));
        assert.ok(index>=0,'original user input must survive native history');
        const input=options.messages[index].content.find(b=>b.type==='text'&&plans.has(b.text)).text;
        const results=options.messages.slice(index+1).filter(m=>m.role==='tool'),available=(options.tools??[]).map(t=>t.name);
        assert.equal(available.includes('document_generate'),input!==INPUT.daily,'generation tool must match foreground work scope');
        assert.equal(available.includes('research_note'),input!==INPUT.daily);
        assert.equal(available.includes('document_proposal_decide'),[INPUT.discard,INPUT.undoBeta].includes(input));
        let [name,args]=plans.get(input)[results.length]??[];
        if(name==='document_proposal_decide'){
          const decision=options.messages[index].content.filter(b=>b.type==='text').map(b=>{try{return JSON.parse(b.text);}catch{return {};}}).find(x=>x?.kind==='document_review_decision');
          args={...args,id:decision.documentDecision.id};
        }
        if(name)tool={name,arguments:JSON.stringify(args)};
        else{
          const last=results.at(-1)?.content.filter(b=>b.type==='text').map(b=>b.text).join('');
          let result;try{result=last?JSON.parse(last):null;}catch{result={parseError:last};}
          text=JSON.stringify({result,available,executed:plans.get(input).slice(0,results.length).map(([name])=>name)});
        }
      }
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),...tool,status:'completed'}]:
        [{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
