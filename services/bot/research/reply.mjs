import {replySpeechText} from '../reply-speech.mjs';
export function projectResearchReply({text,requestId,sources,research,derivations}){
 const derived=derivations?.forRequest(requestId)??[],inputs=new Set(derived.flatMap(d=>d.inputObservationIds));
 const candidates=[...sources.forReply(requestId,text),...(sources.forRequest?.(requestId)??[]).filter(s=>inputs.has(s.observationId))];
 const selected=[...new Map(candidates.map(s=>[s.observationId,s])).values()].map(s=>({...s,...s.excerpt?{excerpt:s.excerpt.slice(0,800)}:{}}));
 const speechText=replySpeechText(text);
 return {text,speechText,sources:selected,derivations:derived,...research?{research:{...research,phase:'finished'}}:{}};
}
