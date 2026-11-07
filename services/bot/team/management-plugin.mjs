/** Only this host-registered tool may write a management decision receipt. */
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readJson,saveJson,readSteps} from '../tasks/agent-files.mjs';
import {normalizeReviewDecision} from './review.mjs';
export const name='opennova-management-review';
export const inject=['tools'];
export async function apply(ctx,config){
  const {defineTool}=await import(pathToFileURL(join(config.harnessRoot,'packages/core/tools/lib/index.js')));
  const path=join(config.runDir,'review-decision.json'),report=readJson(join(config.workspace,'report.json'));
  if(!config.managementReview||report?.reportId!==config.managementReview.reportId)throw Error('management_review_required');
  ctx.effect(()=>ctx.tools.register(defineTool({name:'review_decide',description:'提交本次报告的验收决定。accept须引用真实evidenceIds；request_changes/answer须有具体instruction；缺少用户决定时needs_user。每轮只提交一次。',
    parameters:{action:{type:'string',required:true,enum:['accept','request_changes','answer','needs_user']},summary:{type:'string',required:true},instruction:{type:'string'},evidenceIds:{type:'array',items:{type:'string'}}},
    output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute:async args=>{
      const decision=normalizeReviewDecision(args,{...report,id:report.reportId});const existing=readJson(path);
      if(existing){if(JSON.stringify(existing.decision)!==JSON.stringify(decision))throw Error('review_already_decided');return JSON.stringify({submitted:true,action:decision.action});}
      const inspected=new Set(readSteps(config.runDir).filter(step=>step.tool==='read'&&step.status==='completed'&&typeof step.arguments?.file_path==='string').map(step=>resolve(config.workspace,step.arguments.file_path)));
      if(!inspected.has(join(config.workspace,'report.json')))throw Error('review_report_not_inspected');
      if(decision.action==='accept')for(const artifact of report.artifacts??[])if(decision.evidenceIds.includes(artifact.id)&&(!artifact.path||!inspected.has(resolve(config.workspace,artifact.path))))throw Error('review_artifact_not_inspected');
      saveJson(path,{...config.managementReview,managementRunId:config.runId,decision,createdAt:Date.now()});
      return JSON.stringify({submitted:true,action:decision.action});
    },
  })));
}
