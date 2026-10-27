import {toSpeechText} from '../../agent/speech-text.mjs';
export function projectResearchReply({text,requestId,sources,research,derivations}){
 const derived=derivations?.forRequest(requestId)??[],inputs=new Set(derived.flatMap(d=>d.inputObservationIds));
 const candidates=[...sources.forReply(requestId,text),...(sources.forRequest?.(requestId)??[]).filter(s=>inputs.has(s.observationId))];
 const selected=[...new Map(candidates.map(s=>[s.observationId,s])).values()].map(s=>({...s,...s.excerpt?{excerpt:s.excerpt.slice(0,800)}:{}}));
 const speech=toSpeechText(text.replace(/```[\s\S]*?```/g,'').replace(/\[([^\]\n]*)\]\((?!https?:)[^\n)]*\)/g,'$1'));
 const speechText=speech.length>600?speech.slice(0,560)+'。完整结果已保留在文字界面。':speech;
 return {text,speechText,sources:selected,derivations:derived,...research?{research:{...research,phase:'finished'}}:{}};
}
