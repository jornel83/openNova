/** Legacy fixtures stay in their selected work project; semantic cases use project-runtime-provider. */
export function legacyProjectRoute(options){
  if(options.sessionId!==undefined||!String(options.system).includes('话题与项目路由器'))return null;
  if(options.tools?.length)throw Error('routing_must_be_tool_free');
  const input=JSON.parse(options.messages[0].content[0].text);
  return JSON.stringify({focus:'work',projectId:input.context.projectId??input.projects.find(p=>p.status==='active')?.id??null});
}
export function* routeChunks(text){
  yield {type:'text-delta',index:0,text};
  yield {type:'finish',reason:{kind:'stop'}};
}
